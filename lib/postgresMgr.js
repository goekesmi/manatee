/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/**
 * @overview The PostgreSQL wrapper. Handles all interactions with the
 * underlying PG process.
 *
 *                   _.---.._
 *      _        _.-' \  \    ''-.
 *    .'  '-,_.-'   /  /  /       '''.
 *   (       _                     o  :
 *    '._ .-'  '-._         \  \-  ---]
 *                  '-.___.-')  )..-'
 *                           (_/
 */
var assert = require('assert-plus');
var backoff = require('backoff');
var ZfsClient = require('./zfsClient');
var ConfParser = require('./confParser');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var mod_forkexec = require('forkexec');
var mod_jsprim = require('jsprim');
var mod_lsn = require('pg-lsn');
var path = require('path');
var pg = require('pg');
var Client = pg.Client;
var shelljs = require('shelljs');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var once = require('once');
var posix = require('posix');
var sprintf = require('util').format;
var SnapShotter = require('./snapShotter');
var url = require('url');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');


// --- Globals

var INT_REQUIRED = {
    type: 'integer',
    required: true
};

var STR_REQUIRED = {
    type: 'string',
    required: true
};

var CONFIG_SCHEMA = {
    type: 'object',
    properties: {
        // /manatee/pg/data
        dataDir: STR_REQUIRED,
        // postgres
        dbUser: STR_REQUIRED,
        // 10000
        healthChkInterval: INT_REQUIRED,
        // 60000
        healthChkTimeout: INT_REQUIRED,
        // 300000
        opsTimeout: INT_REQUIRED,
        // /opt/smartdc/manatee/etc/
        postgresConfDir: STR_REQUIRED,
        // postgresql.manta.coal.conf
        postgresConfFile: STR_REQUIRED,
        // recovery.conf
        recoveryConfFile: STR_REQUIRED,
        // pg_hba.conf
        hbaConfFile: STR_REQUIRED,
        // 60000
        replicationTimeout: INT_REQUIRED,
        snapShotterCfg: {
            type: 'object'
        },
        // tcp://postgres@10.77.77.8:5432/postgres
        url: STR_REQUIRED,
        zfsClientCfg: {
            type: 'object'
        },
        // false
        oneNodeWriteMode: {
            type: 'boolean'
        },
        // 60
        pgConnectTimeout: INT_REQUIRED,
        // "/path/.../to/.../manatee-config.json"
        dataConfig: STR_REQUIRED,
        defaultVersion: {
            type: 'string',
            required: true,
            enum: [ '9.2', '9.6' ]
        },
        // /opt/local/postgres/
        pgBaseDir: STR_REQUIRED,
        versions: {
            type: 'object',
            required: true,
            properties: {
                '9.2': STR_REQUIRED,
                '9.6': STR_REQUIRED
            }
        }
    }
};

var TUNABLES_SCHEMA = {
    type: 'object',
    additionalProperties: {
        type: 'object',
        properties: {
            synchronous_commit: {
                type: 'string',
                enum: [
                    'on',
                    'remote_apply',
                    'remote_write',
                    'off'
                ]
            }
        },
        additionalProperties: {
            type: [ 'string', 'boolean', 'number' ]
        }
    }
};


/**
 * postgresql.conf values
 */
var PRIMARY_CONNINFO = 'primary_conninfo';
var READ_ONLY = 'default_transaction_read_only';
var SYNCHRONOUS_COMMIT = 'synchronous_commit';
var SYNCHRONOUS_STANDBY_NAMES = 'synchronous_standby_names';

var PRIMARY_CONNINFO_STR =
    '\'host=%s port=%s user=%s application_name=%s connect_timeout=%s\'';

/**
 * replication status query.
 */
var PG_STAT_REPLICATION =
    'select * from pg_stat_replication where application_name = \'%s\'';


// --- Internal helpers

/**
 * Postgres versions are made up of two components: major and minor numbers.
 * The major numbers are things like "9.2" and "9.6", while the minor number
 * is the part after the last dot, e.g., the "4" in "9.2.4".
 */
function stripMinor(version) {
    assert.string(version, 'version');

    var pos = version.lastIndexOf('.');
    assert.ok(pos > 2, 'pos > 2');

    return (version.substring(0, pos));
}

/**
 * Postgres 9.2 was relaxed about values for "synchronous_standby_names", but
 * in 9.6 we need to add double quotes around the value (as well as the single
 * quotes).
 */
function formatStandbyName(name) {
    return util.format('\'"%s"\'', name);
}

/**
 * Update (or create) a symbolic link to point at a new path.
 */
function updateSymlink(srcpath, dstpath) {
    var curpath = null;

    try {
        curpath = fs.readlinkSync(dstpath);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new verror.VError(e,
                'failed to read symbolic link %s', dstpath);
        }
    }

    if (curpath === null) {
        fs.symlinkSync(srcpath, dstpath);
    } else if (curpath !== srcpath) {
        fs.unlinkSync(dstpath);
        fs.symlinkSync(srcpath, dstpath);
    }
}


// --- Exported functions

/**
 * The manager which manages interactions with PostgreSQL.
 * Responsible for initializing, starting, stopping, and health checking a
 * running postgres instance.
 *
 * @constructor
 *
 * @param {object} options Options object.
 * @param {Bunyan} options.log Bunyan logger.
 * @param {string} options.dataDir Data directory of the PostgreSQL instance.
 * @param {string} options.postgresPath Path to the postgres binary.
 * @param {string} options.pgInitDbPath Path to the initdb binary.
 * @param {string} options.hbaConf Path to the hba config.
 * @param {string} options.postgresConf Path to the PG config.
 * @param {string} options.recoveryConf Path to the PG recovery config.
 * @param {string} options.url URL of this PG instance, e.g.
 * tcp://postgres@10.0.0.0:5432/postgres
 * @param {string} options.dbUser PG user, e.g. postgres.
 * @param {string} options.zfsClientCfg ZFS client config.
 * @param {string} options.snapShotterCfg Snapshotter config.
 * @param {string} options.healthChkInterval Interval of the PG health check in
 * ms.
 * @param {string} options.healthChkTimeout Timeout of the PG health check. If
 * this timeout is exceeded, we assume the PG instance to be dead.
 * @param {string} options.opsTimeout Timeout of init, start and restart
 * operations.
 * @param {string} options.replicationTimeout When a synchronous standby joins,
 * it has to make forward progress before exceeding this timeout.
 * @param {string} options.oneNodeWriteMode Enable writes when there's only 1
 * node in the shard.
 * @param {string} options.pgConnectTimeout connect_timeout for connecting to an
 * upstream postgres instance for replication.  See postgres docs.  This is in
 * seconds.
 *
 * @throws {Error} If the options object is malformed.
 */
function PostgresMgr(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.ifError(mod_jsprim.validateJsonObject(CONFIG_SCHEMA, options));

    EventEmitter.call(this);

    /** @type {Bunyan} The bunyan log object */
    this._log = options.log.child({component: 'PostgresMgr'}, true);
    var log = this._log;
    var self = this;

    self._postgres = null; /* The child postgres process */

    self._defaultVersion = options.defaultVersion;
    self._pgBaseDir = options.pgBaseDir;
    self._versions = options.versions;
    self._dataConf = path.resolve(options.dataConfig);

    /*
     * Base directory containing "9.2" and "9.6" directories, which then
     * contain the source configuration files.
     */
    self._confDir = options.postgresConfDir;
    self.hbaConfFile = options.hbaConfFile;
    self.postgresConfFile = options.postgresConfFile;
    self.recoveryConfFile = options.recoveryConfFile;
    self.tunablesFile = path.join(self._confDir, 'pg_overrides.json');

    /*
     * The directory on disk where the Postgres instance is located, and
     * the paths to write configuration files out to.
     */
    self._dataDir = options.dataDir;
    self._hbaConfPath = path.join(self._dataDir, 'pg_hba.conf');
    self._postgresConfPath = path.join(self._dataDir, 'postgresql.conf');
    self._recoveryConfPath = path.join(self._dataDir, 'recovery.conf');

    /** @type {url} The URL of this postgres instance */
    self._url = url.parse(options.url);
    /** @type {string} The postgres user */
    self._dbUser = options.dbUser;
    /** @type {number} The postgres user uid */
    self._dbUserId = posix.getpwnam(self._dbUser).uid;

    /** @type {object} Configs for the backup client */
    self._zfsClientCfg = options.zfsClientCfg;
    /** @type {string} The postgres user */
    self._zfsClientCfg.dbUser = options.dbUser;
    /** @type {object} The handle to the zfs client */
    self._zfsClient = new ZfsClient(self._zfsClientCfg);

    /** @type {SnapShotter} The pg zfs snapshotter.  */
    self._snapShotter = new SnapShotter(options.snapShotterCfg);

    /*
     * The health check configs and state.
     */
    /** @type {number} health check timeout in ms */
    self._healthChkTimeout = options.healthChkTimeout;
    /** @type {number} health check interval in ms */
    self._healthChkInterval = options.healthChkInterval;
    /** @type {object} health check intervalId */
    self._healthChkIntervalId = null;
    /** @type {number} timestamp of the last healthcheck. */
    self._lastHealthChkTime = null;
    /** @type {boolean} whether postgres is known healthy. */
    self._healthy = null;
    /** @type {error} if !_healthy, the last health check error. */
    self._lastHealthChkErr = null;

    /**
     * @type {number}
     * Postgres operation timeout in ms. Any postgres operation e.g. init,
     * start, restart, will fail upon exceeding this timeout.
     */
    self._opsTimeout = options.opsTimeout;

    /**
     * @type {number}
     * Postgres replication timeout in ms. If a standby hasn't caught up with
     * the primary in this time frame, then this shard may have WAL corruption
     * and is put into a read only state.
     */
    self._replicationTimeout = options.replicationTimeout;

    /**
     * @type {boolean}
     * Enable writes when there's only one node in the shard? This is dangerous
     * and should be avoided as this will cause WAL corruption
     */
    self._oneNodeWriteMode = options.oneNodeWriteMode || false;

    /**
     * @type {number}
     * "connect_timeout", passed to Postgres, this represents a maximum time in
     * seconds before a replication connection to an upstream postgres peer is
     * considered to have failed.  See Postgres documentation for connection
     * strings for details.
     */
    self._pgConnectTimeout = options.pgConnectTimeout;

    /** @type {pg.Client} pg client used for health checks */
    self._pgClient = null;

    /*
     * Outstanding postgres requests.  This is used to avoid queuing inside the
     * postgres client.  See _queryDb().
     */
    self._pgRequestOutstanding = null;
    self._pgRequestsQueued = [];

    /**
     * Filled out on first reconfigure.
     */
    self._pgConfig = null;
    self._running = false;
    self._transitioning = false;
    self._appliedPgConfig = false;

    /**
     * When transitioning between some states, there are times when we kick off
     * a 'background' task.  For example, a primary will wait in read only mode
     * until a new sync catches up, then it will transition to read/write mode.
     * If another reconfiguration happens while that task is still running, that
     * tasks need to be canceled.  Those cancel functions are registered here.
     */
    self._transitionFunc = null;

    log.trace('new postgres manager', options);

    /**
     * Future-looking if this ends up decoupling the postgres process from the
     * manatee-sitter node process, there should be an init method that figures
     * out what the current state of postgres is and emit once the state is
     * known (self._pgConfig, etc).
     */
    setImmediate(function init() {
        var setup = false;
        vasync.pipeline({
            'funcs': [
                function _startHealthCheck(_, cb) {
                    self._startHealthCheck(cb);
                },
                function _statPostgresConf(_, cb) {
                    fs.exists(self._postgresConfPath, function (exists) {
                        setup = exists;
                        return (cb());
                    });
                }
            ]
        }, function () {
            self.emit('init', {
                'setup': setup,
                'online': false
            });
        });
    });
}

module.exports = PostgresMgr;
util.inherits(PostgresMgr, EventEmitter);

/**
 * Get the version that we expect the Postgres data to be for:
 *
 * - If the configuration file that the sitter writes out is present,
 *   use the version stored in there.
 * - If <PG_DIR>/PG_VERSION exists, then we should be on a system that
 *   has already initialized a 9.2 database. Assert that, and then use
 *   Postgres 9.2 paths.
 * - If we haven't intialized a database yet, then use the configured
 *   default paths.
 *
 * This function then returns an object with two fields, to be written
 * out in manatee-config.json:
 *
 * - "initialized", the version of Postgres that the database had been
 *   initialized with.
 * - "current", the version of Postgres that the database on-disk data
 *   should be used with.
 */
PostgresMgr.prototype.getVersionInfo = function () {
    var vfile = path.join(this._dataDir, 'PG_VERSION');
    var pgc = null;
    var curver = null;

    try {
        pgc = JSON.parse(fs.readFileSync(this._dataConf, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new verror.VError(e,
                'failed to read JSON file %s', this._dataConf);
        }
    }

    try {
        curver = fs.readFileSync(vfile, 'utf8').trim();
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new verror.VError(e,
                'failed to read current version from %s', vfile);
        }
    }

    if (pgc === null) {
        if (curver === null) {
            // First time booting, use default version:
            return ({
                initialized: this._versions[this._defaultVersion],
                current: this._versions[this._defaultVersion]
            });
        } else {
            // First time using a sitter that writes manatee-config.json:
            assert.equal(curver, '9.2');
            return ({
                initialized: '9.2.4',
                current: this._versions['9.2']
            });
        }
    }

    assert.object(pgc, 'pgc');
    assert.string(pgc.initialized, 'pgc.initialized');
    assert.string(pgc.current, 'pgc.current');

    var major = stripMinor(pgc.current);
    var current = this._versions[major];

    assert.string(current, 'current');
    assert.equal(pgc.current, current, 'patch version matches');

    if (curver !== null) {
        /*
         * The PG_VERSION file doesn't always exist (e.g., during a rebuild
         * we delete all of the contents of the data/ directory), but when
         * it does, we do a sanity check here to make sure it hasn't been
         * manipulated underneath us.
         */
        assert.equal(curver, major, 'PG_VERSION == current major');
    }

    return ({
        initialized: pgc.initialized,
        current: current
    });
};


/**
 * We support configuring several Postgres options through SAPI tunables,
 * and then put them into the config file when we generate it. We allow
 * specifying the configuration values through several different fields:
 *
 * - "common", options that are valid for all Postgres versions
 * - By major version, e.g. "9.2" or "9.6", for things that are only valid
 *   for that major version.
 * - By full version, e.g. "9.2.4" or "9.6.3", for things that are more
 *   specific to a version.
 *
 * We apply the overrides in that order, so that changes for a specific
 * version can beat out everything else.
 */
PostgresMgr.prototype.getTunables = function (version, major) {
    var tunables;
    var options = {
        synchronous_commit: 'remote_write'
    };

    try {
        tunables = JSON.parse(fs.readFileSync(this.tunablesFile, 'utf8'));
    } catch (e) {
        throw new verror.VError(e, 'failed to load %s', this.tunablesFile);
    }

    assert.ifError(mod_jsprim.validateJsonObject(TUNABLES_SCHEMA, tunables));

    function copy(source) {
        mod_jsprim.forEachKey(source, function (key, value) {
            options[key] = value;
        });
    }

    if (mod_jsprim.hasKey(tunables, 'common')) {
        copy(tunables['common']);
    }

    if (mod_jsprim.hasKey(tunables, major)) {
        copy(tunables[major]);
    }

    if (mod_jsprim.hasKey(tunables, version)) {
        copy(tunables[version]);
    }

    return (options);
};


/**
 * We ship multiple versions of Postgres, and need to be able to run the
 * appropriate version of the binaries, with suitable versions of the
 * configuration files. We determine the relevant version here, and then
 * generate the proper paths.
 */
PostgresMgr.prototype.resolveVersionedPaths = function () {
    var verinfo = this.getVersionInfo();
    var version = verinfo.current;
    var major = stripMinor(version);

    /*
     * Write out all of our versioning information to the dataset.
     */
    fs.writeFileSync(this._dataConf, JSON.stringify(verinfo));

    /*
     * Update the "current" symbolic link, in case we're running for the
     * first time after upgrading the Postgres database.
     */
    var pgVersDir = path.join(this._pgBaseDir, version);
    var pgCurrDir = path.join(this._pgBaseDir, 'current');
    updateSymlink(pgVersDir, pgCurrDir);

    /*
     * Set up paths to the Postgres commands.
     */
    this._dbBinDir = path.join(pgVersDir, 'bin');
    this._pgInitDbPath = path.join(this._dbBinDir, 'initdb');
    this._postgresPath = path.join(this._dbBinDir, 'postgres');

    /*
     * Set up paths to the Postgres configuration files.
     */
    var etcDir = path.join(this._confDir, major);
    this._postgresConf = path.join(etcDir, this.postgresConfFile);
    this._recoveryConf = path.join(etcDir, this.recoveryConfFile);
    this._hbaConf = path.join(etcDir, this.hbaConfFile);

    /*
     * Get appropriate configuration options for this PG version.
     */
    this._additionalPgOptions = this.getTunables(version, major);

    this._log.info({
        versions: verinfo,
        binaries: {
            initdb: this._pgInitDbPath,
            postgres: this._pgInitDbPath
        },
        tunables: this._additionalPgOptions,
        configs: {
            'pg_hba.conf': this._hbaConf,
            'postgresql.conf': this._postgresConf,
            'recovery.conf': this._recoveryConf
        }
    }, 'loaded versioning information');
};

/**
 * Start up the PG instance.  Will return an error if postgres is already
 * running.  Postgres must have previously been reconfigured.
 *
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype.start = function start(callback) {
    var self = this;
    var log = self._log;

    if (self._transitioning) {
        return (callback(new verror.VError('already transitioning')));
    }

    if (self._running) {
        return (callback(new verror.VError('postgres is already running')));
    }

    if (!self._pgConfig) {
        return (callback(new verror.VError(
            'postgres manager hasnt yet been configured')));
    }

    if (self._pgConfig.role === 'none') {
        return (callback(new verror.VError(
            'postgres manager role is none, not allowing start')));
    }

    log.info('PostgresMgr.start: entering');
    self._transitioning = true;
    self._reconfigure(function (err) {
        if (!err) {
            self._running = true;
        }
        log.info({err: err}, 'PostgresMgr.start: exiting');
        self._transitioning = false;
        return (callback(err));
    });
};


/**
 * Shut down the current PG instance.  Will return an error if postgres has
 * is not running.
 *
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype.stop = function stop(callback) {
    var self = this;
    var log = self._log;

    if (self._transitioning) {
        return (callback(new verror.VError('already transitioning')));
    }

    if (!self._running) {
        return (callback(new verror.VError('postgres is not running')));
    }

    log.info('PostgresMgr.stop: entering');
    self._transitioning = true;
    vasync.pipeline({funcs: [
        function _stop(_, cb) {
            self._stop(cb);
        },
        function _setNotRunning(_, cb) {
            self._running = false;
            return (cb());
        }
    ], arg: {}}, function (err, results) {
        log.info({err: err, results: err ? results: null},
                 'PostgresMgr.stop: exiting');
        self._transitioning = false;
        return callback(err);
    });
};


/**
 * Reconfigures the Postgres instance.  Is a no-op if postgres is already
 * configured as specified.  May restart a running Postgres to pick up new
 * configuration.
 *
 * pgConfig is a non-null object representing postgres configuration.  It always
 * has this property:
 *
 * * role (string): one of 'primary', 'standby', or 'none'.
 *
 * If role is 'primary', then there's a 'downstream' property which contains the
 * pgUrl field and the backupUrl field for the corresponding manatee peer.
 *
 * If role is 'standby', then there's an 'upstream' property which contains the
 * pgUrl field and the backupUrl field for the corresponding manatee peer.
 *
 * If role is 'none', then replication is not configured at all, and 'upstream'
 * and 'downstream' are both null.
 *
 * The structures for "upstream" and "downstream" must have postgres connection
 * info as well as the backupUrl.  These structures may contain other fields
 * (which are ignored).  Examples:
 *
 *     {
 *         "role": "primary",
 *         "upstream": null,
 *         "downstream": {
 *             "pgUrl": "tcp://postgres@10.77.77.7:5432/postgres",
 *             "backupUrl": "http://10.77.77.7:12345"
 *         }
 *     }
 *
 *     {
 *         "role": "sync",
 *         "upstream": {
 *             "pgUrl": "tcp://postgres@10.77.77.7:5432/postgres",
 *             "backupUrl": "http://10.77.77.7:12345"
 *         },
 *         "downstream": null
 *     }
 *
 *     {
 *         "role": "async",
 *         "upstream": {
 *             "pgUrl": "tcp://postgres@10.77.77.7:5432/postgres",
 *             "backupUrl": "http://10.77.77.7:12345"
 *         },
 *         "downstream": null
 *     }
 *
 *     {
 *         "role": "none",
 *         "upstream": null,
 *         "downstream": null
 *     }
 *
 * @param {object} pgConfig As described above.
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype.reconfigure = function reconfigure(pgConfig, callback) {
    var self = this;
    var log = self._log;

    function assertPeerIdentifier(peer) {
        assert.string(peer.pgUrl, 'peer.pgUrl');
        assert.string(peer.backupUrl, 'peer.backupUrl');
    }

    assert.object(pgConfig, 'pgConfig');
    assert.string(pgConfig.role, 'pgConfig.role');
    assert.ok(['primary', 'sync', 'async', 'none'].indexOf(pgConfig.role)
              !== -1);
    if (pgConfig.role === 'primary') {
        assert.ok(!pgConfig.upstream, 'pgConfig.upstream is not null');
        if (self._oneNodeWriteMode)
            assert.ok(!pgConfig.downstream, 'pgConfig.downstream is not null');
        else if (pgConfig.downstream)
            assertPeerIdentifier(pgConfig.downstream);
    }
    if (pgConfig.role === 'sync' || pgConfig.role === 'async') {
        assert.object(pgConfig.upstream, 'pgConfig.upstream');
        assertPeerIdentifier(pgConfig.upstream);
        assert.ok(!pgConfig.downstream, 'pgConfig.downstream is not null');
    }
    if (pgConfig.role === 'none') {
        assert.ok(!pgConfig.upstream, 'pgConfig.upstream is not null');
        assert.ok(!pgConfig.downstream, 'pgConfig.downstream is not null');
    }
    assert.func(callback, 'callback');

    callback = once(callback);

    if (self._transitioning) {
        return (callback(new verror.VError('already transitioning')));
    }

    if (!self._running) {
        self._pgConfig = pgConfig;
        self._appliedPgConfig = false;
        return (setImmediate(callback));
    }

    log.info('PostgresMgr.reconfigure: entering');
    self._transitioning = true;
    self._reconfigure(pgConfig, function (err) {
        log.info({err: err}, 'PostgresMgr.reconfigure: exiting');
        self._transitioning = false;
        return (callback(err));
    });
};


/**
 * Gets the Postgres transaction log location.  Postgres must be running,
 * otherwise an error will be returned.
 *
 * @param {PostgresMgr-cb} callback
 * @return {string} A string indicating the current postgres transaction log
 * location.  For example: 0/17B7188
 */
PostgresMgr.prototype.getXLogLocation = function getXLogLocation(callback) {
    var self = this;

    if (!self._running) {
        return (callback(new verror.VError('postgres is not running')));
    }

    function onResponse(err, result) {
        if (err) {
            return (callback(err));
        }
        return (callback(null, result.loc));
    }

    if (self._pgConfig.role === 'primary') {
        self._queryDb('SELECT pg_current_xlog_location() as loc;',
                      onResponse);
    } else {
        self._queryDb('SELECT pg_last_xlog_replay_location() as loc;',
                      onResponse);
    }
};


/**
 * Gets the last know health status of postgres.  Returns a status object with
 * a few fields, described below:
 *
 * @return {boolean} result.healthy True if the last heath check was good.
 * @return {error} result.error The error if healthy === false.
 * @return {integer} result.lastCheck The timestamp the last time the heath
 * check was run.
 */
PostgresMgr.prototype.status = function status() {
    var self = this;
    return ({
        'healthy': self._healthy,
        'error': self._lastHealthChkErr,
        'lastCheck': self._lastHealthChkTime
    });
};


/**
 * Closes down this PostgresMgr, stopping Postgres and the health check.  Once
 * called, you must create a new PostgresMgr rather than trying to reuse the
 * current one.
 *
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype.close = function close(callback) {
    var self = this;
    var log = self._log;

    log.info('PostgresMgr.close: entering');
    vasync.pipeline({
        'funcs': [
            function _shutdownPostgres(_, cb) {
                if (!self._running) {
                    return (cb());
                }
                self.stop(cb);
            },
            function _stopHealthCheck(_, cb) {
                self._stopHealthCheck(cb);
            }
        ]
    }, function (err) {
        log.info({err: err}, 'PostgresMgr.close: exiting');
        return (callback(err));
    });
};


/**
 * Reconfigures and either starts or restarts postgres.
 *
 * See the docs for .reconfigure for an explaination of pgConfig.
 */
PostgresMgr.prototype._reconfigure = function _reconfigure(pgConfig, callback) {
    if (typeof (pgConfig) === 'function') {
        callback = pgConfig;
        pgConfig = null;
    }

    var self = this;
    function onReconfigure(err) {
        if (!err) {
            self._pgConfig = pgConfig;
            self._appliedPgConfig = true;
        }
        return (callback(err));
    }

    //Reconfigure to become nothing.
    if (pgConfig && pgConfig.role === 'none') {
        return (setImmediate(onReconfigure));
    }

    function comparePeers(a, b) {
        if (!a && !b) {
            return (true);
        }
        return (a.pgUrl === b.pgUrl &&
                a.backupUrl === b.backupUrl);
    }

    //If we already applied the same postgres config, there's nothing to do
    // but start postgres and return.
    if (pgConfig && self._pgconfig &&
        pgConfig.role === self._pgConfig.role &&
        comparePeers(pgConfig.upstream, self._pgConfig.upstream) &&
        comparePeers(pgConfig.downstream, self._pgConfig.downstream) &&
        self._appliedPgConfig) {
        if (self._postgres) {
            return (setImmediate(callback));
        } else {
            return (self._start(callback));
        }
    }

    //If we're already running and this is only a standby change, delegate
    // out to ._updateStandby
    if (self._postgres && self._pgConfig && pgConfig &&
        self._pgConfig.role === 'primary' &&
        pgConfig.role === 'primary') {
        return (self._updateStandby(pgConfig.downstream.pgUrl, onReconfigure));
    }

    //For anything else after this point, we just do the whole thing since it is
    // either a start, promotion, or reconfiguration.
    if (!pgConfig) {
        pgConfig = self._pgConfig;
    }

    //Otherwise, we require a full reconfiguration.
    if (pgConfig.role === 'primary') {
        //In one node write mode, downstream will be null.
        var pgUrl = pgConfig.downstream ? pgConfig.downstream.pgUrl : null;
        return (self._primary(pgUrl, onReconfigure));
    } else {
        return (self._standby(pgConfig.upstream.pgUrl,
                              pgConfig.upstream.backupUrl,
                              onReconfigure));
    }
};


PostgresMgr.prototype._waitForStandby = function (stdby) {
    assert.string(stdby, 'stdby');

    var self = this;
    var log = self._log;

    log.info('PostgresMgr._waitForStandby: entering');

    var replErrMsg = 'could not verify standby replication status, ' +
        'possible WAL corruption remaining in readonly mode';

    var checkReplEmitter;
    // we don't check for replication status if a standby doesn't exist.
    var replEmitter = new EventEmitter();
    replEmitter.cancel = function cancel() {
        log.info('PostgresMgr._waitForStandby: cancelling operation');
        // We only try and cancel the replication check. But only after it has
        // been started.
        if (checkReplEmitter) {
            log.info('PostgresMgr._waitForStandby: replication check ' +
                     'started, cancelling check');
            checkReplEmitter.cancel();
        } else {
            log.info('PostgresMgr._waitForStandby: replication check not ' +
                     'started, trying again in 1s.');
            setTimeout(cancel, 1000);
        }
    };

    vasync.pipeline({funcs: [
        function _checkReplStatus(_, cb) {
            replEmitter.startedCheckRepl = true;
            checkReplEmitter = self._checkRepl(stdby);
            checkReplEmitter.once('error', function (err) {
                log.fatal({err: err}, replErrMsg);
                return cb(err);
            });

            checkReplEmitter.once('done', cb);
        },
        function _enableWrites(_, cb) {
            var confOpts = {};
            confOpts[SYNCHRONOUS_STANDBY_NAMES] =
                formatStandbyName(stdby);
            self._updatePgConf(confOpts, cb);
        },
        function _sighup(_, cb) {
            self._sighup(cb);
        }
    ], arg: {}}, function (err) {
        if (err) {
            log.error({
                err: err,
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._waitForStandby: error');
        } else {
            log.info({
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._waitForStandby: complete');
        }
        //TODO: Not sure if upstreams check for this error, or what they would
        // do if there was one...
        replEmitter.emit('done', err);
    });

    return (replEmitter);
};


/**
 * Transition the PostgreSQL instance to primary mode.
 *
 * @param {String} stdby The standby, like:
 *                       tcp://postgres@10.77.77.10:5432/postgres
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype._primary = function _primary(stdby, callback) {
    var self = this;
    var log = self._log;

    log.info({
        url: self._url,
        standby: stdby
    }, 'PostgresMgr._primary: entering.');

    vasync.pipeline({funcs: [
        function _cancelTransitioning(_, cb) {
            if (self._transitionFunc) {
                self._transitionFunc.on('done', cb);
                self._transitionFunc.cancel();
            } else {
                return (cb());
            }
        },
        function _initDb(_, cb) {
            self._initDb(cb);
        },
        function _deleteRecoveryConf(_, cb) {
            fs.unlink(self._recoveryConfPath, function (e) {
                if (e && e.code !== 'ENOENT') {
                    return cb(e);
                } else {
                    return cb();
                }
            });
        },
        function _updateConfigs(_, cb) {
            var confOpts = {};
            if (!self._oneNodeWriteMode) {
                confOpts[READ_ONLY] = 'on';
            } else {
                log.warn('enable write mode with only one ' +
                         'node, may cause WAL corruption!');
            }
            self._updatePgConf(confOpts, cb);
        },
        function _restart(_, cb) {
            self._restart(cb);
        },
        function _snapshot(_, cb) {
            self._snapShotter.createSnapshot(String(Date.now()), cb);
        },
        function _startReplCheck(_, cb) {
            if (!stdby) {
                return (cb());
            }
            self._transitionFunc = self._waitForStandby(stdby);
            self._transitionFunc.on('done', function () {
                self._transitionFunc = null;
            });
            return (cb());
        }
    ], arg: {}}, function (err) {
        if (err) {
            log.error({
                err: err,
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._primary: error');
        } else {
            log.info({
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._primary: complete');
        }
        return (callback(err));
    });
};


/**
 * Updates the standby of the current node. This assumes the current node is
 * already a primary. This does only sends SIGHUP to postgres, not SIGINT.
 *
 * @param {String} stdby The standby, like:
 *                       tcp://postgres@10.77.77.8:5432/postgres)
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype._updateStandby = function _updateStandby(stdby,
                                                               callback) {
    var self = this;
    var log = self._log;

    log.info({
        url: self._url,
        standby: stdby
    }, 'PostgresMgr._updateStandby: entering.');

    vasync.pipeline({funcs: [
        function _cancelTransitioning(_, cb) {
            if (self._transitionFunc) {
                self._transitionFunc.on('done', cb);
                self._transitionFunc.cancel();
            } else {
                return (cb());
            }
        },
        function _updateConfigs(_, cb) {
            var confOpts = {};
            if (stdby) {
                /*
                 * If there is a standby, we always want to stay in read-only
                 * mode.
                 */
                confOpts[SYNCHRONOUS_STANDBY_NAMES] =
                    formatStandbyName(stdby);
                confOpts[READ_ONLY] = 'on';
            } else if (!self._oneNodeWriteMode) {
                confOpts[READ_ONLY] = 'on';
            } else {
                log.warn('enable write mode with only one node, may cause ' +
                         'WAL corruption!');
            }

            self._updatePgConf(confOpts, cb);
        },
        function _sighup(_, cb) {
            self._sighup(cb);
        },
        function _startReplCheck(_, cb) {
            if (!stdby) {
                return (cb());
            }
            self._transitionFunc = self._waitForStandby(stdby);
            self._transitionFunc.on('done', function () {
                self._transitionFunc = null;
            });
            return (cb());
        }
    ], arg: {}}, function (err) {
        if (err) {
            log.info({
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._updateStandby: error');
        } else {
            log.info({
                standby: stdby,
                url: self._url
            }, 'PostgresMgr._updateStandby: complete');
        }
        return (callback(err));
    });
};


/**
 * Transitions a postgres instance to standby state.
 *
 * The only long-running task in this is the restore, which can take minutes to
 * complete.  In other places we set up a transitioning function that can be
 * canceled so that the manatee state machine doesn't get stuck when something
 * downstream fails.  In the case of a restore, if the downstream fails then the
 * error will propagate naturally from the zfs client.  We could implement
 * canceling the zfs receive from this side but since this node would have to
 * start a restore from some other node, we might as well let it finish (if it
 * can), then pass control back to the state machine to process the change once
 * the restore is complete.
 *
 * @param {string} primUrl The postgres url of the primary, like:
 *                         tcp://postgres@10.77.77.10:5432/postgres
 * @param {string} backupUrl The http url of the primary's backup service, like:
 *                           http://10.77.77.10:12345
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype._standby = function _standby(primUrl,
                                                   backupUrl,
                                                   callback) {
    var self = this;
    var log = self._log;
    var primaryUrl = url.parse(primUrl);
    var backupSnapshot;

    log.info({
        primaryUrl: primaryUrl.href,
        backupUrl: backupUrl
    }, 'PostgresMgr._standby: entering');

    /**
     * Update the primary connection info in recovery.conf
     */
    function updatePrimaryConnInfo(cb) {
        var opts = {};
        var value = sprintf(
            PRIMARY_CONNINFO_STR,
            primaryUrl.hostname,
            primaryUrl.port,
            primaryUrl.auth,
            self._url.href,
            self._pgConnectTimeout);
        opts[PRIMARY_CONNINFO] = value;
        self._updateRecoveryConf(opts, cb);
    }

    function updateConfigurations(cb) {
        try {
            self.resolveVersionedPaths();
        } catch (e) {
            cb(new verror.VError(e,
                'failed to resolve versioned paths while ' +
                'trying to update configuration files'));
            return;
        }

        /*
         * Update primary_conninfo to point to the new (host, port) pair.
         */
        updatePrimaryConnInfo(function (err) {
            if (err) {
                cb(err);
                return;
            }

            /*
             * Set synchronous_commit to off in order
             * to enable async replication.
             */
            var opts = {};
            opts[SYNCHRONOUS_COMMIT] = 'off';

            self._updatePgConf(opts, cb);
        });
    }

    /**
     * Restores the current postgres instance from the primary via zfs_recv.
     */
    function restore(cb) {
        log.info({
            zfsClientCfg: self._zfsClientCfg
        }, 'PostgresMgr._standby: restoring db from primary');

        self._zfsClient.restore(backupUrl, function (err2, snapshot) {
            backupSnapshot = snapshot;
            if (err2) {
                log.info({
                    err: err2,
                    backupUrl: backupUrl
                }, 'PostgresMgr._standby: could not restore from primary');
                return cb(err2);
            }
            var cmd = 'chown -R ' + self._dbUser + ' ' + self._dataDir;
            log.info({
                cmd: cmd
            }, 'PostgresMgr._standby: finished backup, chowning datadir');
            exec(cmd, cb);
        });
    }

    vasync.pipeline({funcs: [
        function _cancelTransitioning(_, cb) {
            if (self._transitionFunc) {
                self._transitionFunc.on('done', cb);
                self._transitionFunc.cancel();
            } else {
                return (cb());
            }
        },
        // have to stop postgres here first such that we can assert the dataset,
        // other wise some actions will fail with EBUSY
        function _stopPostgres(_, cb) {
            log.info('PostgresMgr.initDb: stop postgres');
            self._stop(cb);
        },
        // fix for MANATEE-90, always check that the dataset exists before
        // starting postgres
        function _assertDataset(_, cb) {
            self._zfsClient.assertDataset(cb);
        },
        /*
         * Attempt to update the configuration for standby mode. If this step
         * errors out, then we assume that we need to perform a restore of the
         * database from the primary. This is controlled by the _.isRestore flag
         * attached to the vasync args, and checked in the following steps.
         */
        function _updateConfigs(_, cb) {
            updateConfigurations(function (err) {
                _.isRestore = err;
                cb();
            });
        },
        // restart pg to enable the config changes.
        function _restart(_, cb) {
            if (_.isRestore) {
                return cb();
            } else {
                self._restart(function (err) {
                    _.isRestore = err;
                    return cb();
                });
            }
        },
        // following run only if _.isRestore is needed
        function _restore(_, cb) {
            if (!_.isRestore) {
                cb();
                return;
            }

            log.warn({ err: _.isRestore }, 'PostgresMgr._standby: ' +
                'failed to move into standby state, performing restore');

            restore(function (err) {
                // restore the original backup if zfs recv fails.
                if (err) {
                    self._zfsClient.restoreDataset(backupSnapshot,
                        function () {
                        return cb(err);
                    });
                } else {
                    return cb();
                }
            });
        },
        /*
         * If we've just performed a restore, then we need to update the
         * configuration files again, since the ZFS dataset will contain
         * a configuration made for the upstream database.
         */
        function _updateConfigsAgain(_, cb) {
            if (!_.isRestore) {
                cb();
                return;
            }

            updateConfigurations(cb);
        },
        function _restartAgain(_, cb) {
            if (!_.isRestore) {
                return cb();
            } else {
                self._restart(function (err) {
                    // restore the original snapshot if we can't restart, which
                    // usuallly indicates corruption in the received dataset
                    if (err) {
                        self._zfsClient.restoreDataset(backupSnapshot,
                                                       function () {
                            return cb(err);
                        });
                    } else {
                        return cb();
                    }
                });
            }
        },
        // if the restore is successful, then destroy the backupdataset
        function _destroyBackupDatset(_, cb) {
            if (!_.isRestore) {
                return cb();
            } else {
                var cmd = 'zfs destroy -r ' +
                    backupSnapshot.split('@')[0];
                log.info({cmd: cmd}, 'PostgresMgr._standby: exec');
                exec(cmd, cb);
            }
        }
    ], arg: {}}, function (err) {
        if (err) {
            log.info({
                err:err,
                primaryUrl: primaryUrl.href,
                backupUrl: backupUrl
            }, 'PostgresMgr._standby: error');
            return callback(err);
        } else {
            log.info({
                primaryUrl: primaryUrl.href,
                backupUrl: backupUrl
            }, 'PostgresMgr._standby: complete');
            return callback();
        }
    });
};


/**
 * @return {string} The PostgreSQL URL, e.g. tcp://postgres@10.0.0.1:5324/
 */
PostgresMgr.prototype.getUrl = function getUrl() {
    var self = this;
    assert.object(self._url, 'this.url');
    return self._url;
};


/**
 * Stops the running postgres instance.
 *
 * Sends the following signals in order:
 * SIGTERM, SIGINT, SIGQUIT, SIGKILL
 * The first will wait for all clients to terminate before quitting, the second
 * will forcefully disconnect all clients, and the third will quit immediately
 * without proper shutdown, resulting in a recovery run during restart.
 *
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype._stop = function (callback) {
    var self = this;
    var log = self._log;
    callback = once(callback);
    log.info('PostgresMgr.stop: entering');

    var successful;
    var postgres = self._postgres;
    if (!postgres) {
        log.info({
            postgresHandle: postgres,
            datadir: self._dataDir
        }, 'PostgresMgr.stop: exiting, postgres handle DNE, was pg started by' +
            ' another process?');

        return callback();
    }
    // MANATEE-81: unregister previous exit listener on the postgres handle.
    postgres.removeAllListeners('exit');

    postgres.once('exit', function (code, signal) {
        // always remove reference to postgres handle on exit.
        self._postgres = null;
        log.info({
            code: code,
            signal: signal
        }, 'PostgresMgr.stop: postgres exited with');
        successful = true;
        return callback();
    });

    log.info('PostgresMgr.stop: trying SIGINT');
    postgres.kill('SIGINT');
    // simply wait opsTimeout before executing SIGQUIT
    setTimeout(function () {
        if (!successful) {
            log.info('PostgresMgr.stop: trying SIGQUIT');
            postgres.kill('SIGQUIT');
        }
        // set another timeout and SIGKILL
        setTimeout(function () {
            if (!successful) {
                log.info('PostgresMgr.stop: trying SIGKILL');
                postgres.kill('SIGKILL');
            }
            // set another timeout and return error
            setTimeout(function () {
                if (!successful) {
                    log.error('PostgresMgr.stop: failed');
                    var err2 = new verror.VError('SIGKILL failed');
                    postgres.removeAllListeners('exit');
                    return callback(err2);
                }
            });
        }, self._opsTimeout);

    }, self._opsTimeout);
};


/**
 * Starts the periodic health checking of the pg instance.  emits error if
 * healthchk fails
 *
 * @param {PostgresMgr-cb} callback
 */
PostgresMgr.prototype._startHealthCheck = function (callback) {
    var self = this;
    var log = self._log;
    log.info('PostgresMgr.starthealthCheck: entering');

    if (self._healthChkIntervalId) {
        log.info('PostgresMgr.starthealthCheck: health check already running');
        return callback();
    } else {
        self._healthy = null;
        self._lastHealthChkErr = null;
        self._lastHealthChkTime = Date.now();
        self._healthChkIntervalId = setInterval(function () {
            // set a timeout in case _health() doesn't return in time
            var timeoutId = setTimeout(function () {
                /**
                 * Unhealthy event, emitted when there's an unrecoverable error
                 * with the PostgreSQL instance. Usually this is because of:
                 * - The healthcheck has failed.
                 * - PostgreSQL exited on its own.
                 * - The manager was unable to start PostgreSQL.
                 *
                 * @event PostgresMgr#error
                 * @type {verror.VError} error
                 */
                self._healthy = false;
                self._lastHealthChkErr = new verror.VError(
                    'PostgresMgr._startHealthCheck() timed out');
                self.emit('unhealthy', self._lastHealthChkErr);
            }, self._healthChkTimeout);

            self._health(healthHandler.bind(self, timeoutId));

        }, self._healthChkInterval);

        // return callback once healthcheck has been dispatched
        log.info('PostgresMgr.starthealthCheck: exiting');
        return callback();
    }

    /**
     * only error out when we've exceeded the timeout
     */
    function healthHandler(timeoutId, err) {
        var timeElapsed = Date.now() - self._lastHealthChkTime;
        log.trace({
            err: err,
            timeElapsed: timeElapsed,
            timeOut: self._healthChkTimeout
        }, 'PostgresMgr.health: returned');
        clearTimeout(timeoutId);
        if (err) {
            if (timeElapsed > self._healthChkTimeout) {
                var msg = 'PostgresMgr.health: health check timed out';
                /**
                 * Error event, emitted when there's an unrecoverable error
                 * with the PostgreSQL instance.
                 * Usually this is because of:
                 * - The healthcheck has failed.
                 * - PostgreSQL exited on its own.
                 * - The manager was unable to start PostgreSQL.
                 *
                 * @event PostgresMgr#error
                 * @type {verror.VError} error
                 */
                self._healthy = false;
                self._lastHealthChkErr =  new verror.VError(err, msg);
                self.emit('unhealthy', self._lastHealthChkErr);
            }
        } else {
            self._lastHealthChkTime = Date.now();
            self._healthy = true;
            self._lastHealthChkErr = null;
            self.emit('healthy');
        }
    }
};


/**
 * Stop the postgres health check.
 * @param {function} callback The callback of the form f(err).
 */
PostgresMgr.prototype._stopHealthCheck = function (callback) {
    var self = this;
    var log = self._log;
    log.info('PostgresMgr.stopHealthCheck: entering');

    if (self._healthChkIntervalId) {
        clearInterval(self._healthChkIntervalId);
        self._healthChkIntervalId = null;
    } else {
        log.info('PostgresMgr.stopHealthCheck: not running');
    }

    return (setImmediate(callback));
};


/**
 * Start the postgres instance.
 * @param {function} callback The callback of the form f(err, process).
 */
PostgresMgr.prototype._start = function _start(cb) {
    var self = this;
    var log = self._log;
    var stdout = '';
    var stderr = '';
    var intervalId = null;
    cb = once(cb);

    try {
        self.resolveVersionedPaths();
    } catch (e) {
        cb(new verror.VError(e,
            'failed to resolve versioned paths while ' +
            'trying to start Postgres'));
        return;
    }

    /**
     * Always reset and clear the healthcheck before callback.
     * This callback is invoked when the child PG process has started.
     */
    var callback = once(function (err, pg2) {
        clearInterval(intervalId);
        log.info('clearing healthcheck');

        cb(err, pg2);
    });

    log.info({
        postgresPath: self._postgresPath,
        dataDir: self._dataDir
    }, 'PostgresMgr.start: entering');

    // delete postmaster.pid if it exists.
    try {
        fs.unlinkSync(self._dataDir + '/postmaster.pid');
    } catch (e) {
        // ignore errors since postmaster might not exist in the first place
    }

    assert.string(self._postgresPath, 'self._postgresPath');

    var postgres = spawn(self._postgresPath, ['-D', self._dataDir],
                         {uid: self._dbUserId});
    self._postgres = postgres;

    postgres.stdout.on('data', function (data) {
        var out = data.toString();
        log.trace('postgres stdout: ', out);
        stdout += out;
    });

    postgres.stderr.on('data', function (data) {
        var out = data.toString();
        log.trace('postgres stderr: ', out);
        stderr += out;
    });

    postgres.on('exit', function (code, signal) {
        // remove reference to postgres handle on exit.
        self._postgres = null;
        var reason = code !== null ? 'code ' + code : 'signal ' + signal;
        var err = new verror.VError('postgres exited unexpectedly (%s); ' +
            'stdout = %s, stderr = %s', reason, stdout, stderr);
        log.info({
            postgresPath: self._postgresPath,
            dataDir: self._dataDir,
            code: code,
            signal: signal,
            err: err
        }, 'PostgresMgr.start: postgres -D exited with err');

        /*
         * fix for MANTA-997. This callback when invoked more than once
         * indicates that postgres has exited unexpectedly -- usually as a
         * result of unexpected pg crash.  Since postgres is started as a child
         * process, when it unexpectedly exits, start(), which has already
         * returned when postgres was first started, will return another
         * callback indicating postgres has exited.  If this callback is
         * invoked, it manifests itself by causing vasync to throw a pipeline
         * error.  What we really want is to indicate this as fatal and exit
         * manatee.
         */
        if (callback.called) {
            var errMsg = 'postgres exited unexpectedly, ' +
                'exiting manatee, please check for pg core dumps.';
            log.fatal(errMsg);
            /**
             * Error event, emitted when there's an unrecoverable error
             * with the PostgreSQL instance.
             * Usually this is because of:
             * - The healthcheck has failed.
             * - PostgreSQL exited on its own.
             * - The manager was unable to start PostgreSQL.
             *
             * @event PostgresMgr#error
             * @type {verror.VError} error
             */
            //TODO: Do we want to crash at this point?
            self.emit('error', new verror.VError(err, errMsg));
        }

        return callback(err);
    });

    // Wait for db to comeup via healthcheck
    var time = new Date().getTime();
    intervalId = setInterval(function () {
        self._health(function (err) {
            var timeSinceStart = new Date().getTime() - time;
            if (err) {
                log.info({
                    err: err,
                    timeSinceStart: timeSinceStart,
                    opsTimeout: self._opsTimeout,
                    postgresPath: self._postgresPath,
                    dataDir: self._dataDir
                }, 'PostgresMgr.start: db has not started');

                if (timeSinceStart > self._opsTimeout) {
                    log.info({
                        timeSinceStart: timeSinceStart,
                        opsTimeout: self._opsTimeout,
                        postgresPath: self._postgresPath,
                        dataDir: self._dataDir
                    }, 'PostgresMgr.start: start timeout');

                    self._stop(function () {
                        return callback(err, postgres);
                    });
                }
            } else {
                log.info({
                    timeSinceStart: timeSinceStart,
                    opsTimeout: self._opsTimeout,
                    postgresPath: self._postgresPath,
                    dataDir: self._dataDir
                }, 'PostgresMgr.start: db has started');
                return callback(null, postgres);
            }
        });
    }, 1000);
};


/**
 * Initializes the postgres data directory for a new DB. This can fail if the
 * db has already been initialized - this is okay, as startdb will fail if init
 * didn't finish succesfully.
 *
 * This function should only be called by the primary of the shard. Standbys
 * will not need to initialize but rather restore from a already running
 * primary.
 *
 * @param {function} callback The callback of the form f(err).
 */
PostgresMgr.prototype._initDb = function (callback) {
    var self = this;
    var log = self._log;
    log.info({
        dataDir: self._dataDir
    }, 'PostgresMgr.initDb: entering');

    vasync.pipeline({funcs: [
        // have to stop postgres here first such that we can assert the dataset,
        // other wise some actions will fail with EBUSY
        function stopPostgres(_, cb) {
            log.info('PostgresMgr.initDb: stop postgres');
            self._stop(cb);
        },
        // fix for MANATEE-90, always check that the dataset exists before
        // initializing postgres
        function assertDataset(_, cb) {
            log.info({dataset: self._zfsClientCfg.dataset},
                'PostgresMgr.initDb: assert dataset');
            self._zfsClient.assertDataset(cb);
        },
        function checkDataDirExists(_, cb) {
            log.info({datadir: self._dataDir},
                'PostgresMgr.initDb: check datadir exists');
            fs.stat(self._dataDir, function (err, stats) {
                if (err || !stats.isDirectory()) {
                    return cb(new verror.VError(err,
                        'postgres datadir ' + self._dataDir + ' DNE'));
                }

                return cb();
            });

        },
        function setDataDirOwnership(_, cb) {
            var cmd = 'chown -R ' + self._dbUser + ' '  + self._dataDir;
            log.info({cmd: cmd},
                'PostgresMgr.initDb: changing datadir ownership to postgres');
            exec(cmd, cb);
        },
        function setDataDirPerms(_, cb) {
            var cmd = 'chmod 700 ' + self._dataDir;
            log.info({cmd: cmd},
                'PostgresMgr.initDb: changing datadir perms to 700');
            exec(cmd, cb);

        },
        function _initDb(_, cb) {
            try {
                self.resolveVersionedPaths();
            } catch (e) {
                cb(new verror.VError(e,
                    'failed to resolve versioned paths before running initdb'));
                return;
            }

            assert.string(self._pgInitDbPath, 'self._pgInitDbPath');

            var args = [ 'sudo', '-u', self._dbUser,
                         self._pgInitDbPath, '--encoding=UTF-8', '--locale=C',
                         '-D', self._dataDir ];

            log.info({cmd: 'initdb', argv: args},
                'PostgresMgr.initDb: initializing db');

            mod_forkexec.forkExecWait({ argv: args }, function (err, info) {
                // ignore errors since the db could already be initialized
                log.info(info, 'PostgresMgr.initDb: initdb returned');

                shelljs.cp('-f', self._hbaConf, self._dataDir + '/pg_hba.conf');
                log.info({
                    dataDir: self._dataDir,
                    postgresqlConf: self._postgresConf
                }, 'PostgresMgr.initDb: copying postgresql.conf to data dir');

                //TODO: Is this necessary?  Shouldn't we copy this over
                // in other places and not here?  I'd rather this file doesn't
                // exist than it exist and is wrong.
                shelljs.cp('-f', self._postgresConf, self._dataDir +
                    '/postgresql.conf');

                cb();
            });
        }
    ], arg: {}}, function (err) {
        log.info({err: err}, 'PostgresMgr.initDb: finished');
        return callback(err);
    });
};

/*
 * Postgres query management
 *
 * The _queryDb() method below is used in three contexts in which we want to
 * query the postgres that's instance under our watch:
 *
 *   (1) getXLogLocation(), which is used during cluster takeover to identify
 *       the starting xlog position of the cluster
 *
 *   (2) _health(), which is invoked at a few points (after postgres is started
 *       and again periodically)
 *
 *   (3) _checkReplStatus(), which is used to poll on when a downstream standby
 *       has connected
 *
 * Importantly, none of these requests happens often (more than once every few
 * seconds), and we rarely want to issue more than one at a time.  When we do,
 * we're generally fine with queueing them on the same database connection, so
 * long as none of these requests blocks indefinitely.  (Fortunately, all of
 * these are simple, read-only requests.)
 *
 * While the client interface does support issuing multiple requests (by
 * queueing them), due to node-postgres issue #718, we cannot make use of that
 * functionality.  To manage dispatching of requests to the client, all requests
 * are funneled through _queryDb(), which pushes the request onto a queue and
 * kicks the queue.  This mechanism also allows us to make sure that if there's
 * a client error, we attempt to recover by reinitializing the postgres client.
 *
 * The following properties of the PostgresMgr are used to manage this:
 *
 *     _pgRequestOutstanding (object)   Identifies the request that we've
 *                                      dispatched to the postgres client.
 *                                      If null, no request is outstanding.
 *                                      This object has properties "queryStr"
 *                                      and "callback", which correspond to the
 *                                      arguments to _queryDb().
 *
 *     _pgRequestsQueued (array)        Array of requests queued behind the
 *                                      outstanding request.  Each element of
 *                                      the array has the same signature as
 *                                      _pgRequestOutstanding.
 *
 * It's up to the consumers to make sure that the queue does not grow without
 * bound, but for the reasons mentioned above, it's very unlikely to even grow
 * beyond length two.
 *
 * The internal interface to this mechanism is just:
 *
 *     _queryDb(queryStr, callback): Just enqueues a request onto the queue and
 *                                   calls _pgQueryKick().  "callback" is
 *                                   invoked upon completion.
 *
 * and the implementation consists of:
 *
 *     _pgQueryKick():               If there is no outstanding request and
 *                                   there is at least one queued request,
 *                                   _pgQueryKick() pops the queue and issues
 *                                   the request.  Otherwise, it does nothing.
 *                                   It may be called in any context, but it's
 *                                   expected to be called when a request is
 *                                   either enqueued or completed in order to
 *                                   make sure we keep processing the queue.
 *
 *     _pgQueryFini(err, result):    Invoked when a query completes
 *                                   successfully, completes with an error, or
 *                                   when the client experiences an error and a
 *                                   query is outstanding.  In all cases, logs
 *                                   any error, invokes the callback() for the
 *                                   currently executing query with "err" and
 *                                   "result", and then calls _pgQueryKick() to
 *                                   resume processing.  If there's an error,
 *                                   the client is destroyed so that subsequent
 *                                   queries will cause a new client to be
 *                                   created.
 */

PostgresMgr.prototype._pgQueryKick = function () {
    var self = this;
    var log = self._log;
    var rq, queryStr;
    var query, result;

    if (self._pgRequestOutstanding !== null) {
        log.debug('pg queue kicked: outstanding request already');
        return;
    }

    if (self._pgRequestsQueued.length === 0) {
        log.trace('pg queue kicked: no requests queued');
        return;
    }

    rq = self._pgRequestsQueued.shift();
    self._pgRequestOutstanding = rq;
    queryStr = rq.queryStr;

    if (!self._pgClient) {
        self._pgClient = new Client(self._url.href);
        self._pgClient.once('error', function (err) {
            log.error({err: err}, 'got pg client error');
            self._pgClient.removeAllListeners();
            if (self._pgRequestOutstanding !== null) {
                self._pgQueryFini(err);
            } else {
                /* See _pgQueryFini(). */
                self._pgClient = null;
            }
        });
        self._pgClient.connect();
    }

    query = self._pgClient.query(queryStr);
    result = null;
    log.trace('querying', query);

    query.once('row', function (row) {
        log.trace({ row: row }, 'got row');
        result = row;
    });

    query.once('error', function (err) {
        /*
         * It's conceivable in this case that we got a client error and already
         * finished handling this request above.  In that case, we ignore this
         * second error.
         */
        if (rq == self._pgRequestOutstanding) {
            self._pgQueryFini(err);
        } else {
            log.debug({ 'err': err },
                'got query error for non-outstanding request');
        }
    });

    query.once('end', function () {
        assert.ok(rq == self._pgRequestOutstanding);
        self._pgQueryFini(null, result);
    });
};

PostgresMgr.prototype._pgQueryFini = function (err, result) {
    var self = this;
    var log = self._log;
    var rq;

    assert.ok(self._pgRequestOutstanding !== null);
    rq = self._pgRequestOutstanding;
    self._pgRequestOutstanding = null;

    if (err) {
        log.warn({ 'err': err }, 'got err');
        err = new verror.VError(err, 'error whilst querying postgres');

        /*
         * Clear the postgres client so that we create a new one for the next
         * query.  Do this before invoking the callback in case the callee
         * enqueues another request.
         */
        self._pgClient = null;
        rq.callback(err);
    } else {
        log.trace('query ended!');
        rq.callback(null, result);
    }

    self._pgQueryKick();
};

PostgresMgr.prototype._queryDb = function (queryStr, callback) {
    var self = this;
    var log = self._log;
    callback = once(callback);
    log.trace({
        query: queryStr,
        nPrevRequests: self._pgRequestsQueued.length
    }, 'PostgresMgr.query: entering.');

    self._pgRequestsQueued.push({
        'queryStr': queryStr,
        'callback': callback
    });

    self._pgQueryKick();
};

/**
 * Sends sighup to PostgreSQL.
 */
PostgresMgr.prototype._sighup = function (callback) {
    var self = this;
    var log = self._log;
    log.info('PostgresMgr.sighup: entering');

    var postgres = self._postgres;
    postgres.kill('SIGHUP');
    callback();
};


/**
 * Update keys in postgresql.conf. Starts from the default conf that ships with
 * Manatee, meaning that keys in the current config not present in the default
 * config will be lost.
 */
PostgresMgr.prototype._updatePgConf = function (updates, cb) {
    var options =
        mod_jsprim.mergeObjects(updates, null, this._additionalPgOptions);
    this._updateConf(options, this._postgresConf, this._postgresConfPath, cb);
};


/**
 * Update keys in recovery.conf. Starts from the default conf that ships with
 * Manatee, meaning that keys in the current config not present in the default
 * config will be lost.
 */
PostgresMgr.prototype._updateRecoveryConf = function (options, cb) {
    var self = this;
    self._updateConf(options, self._recoveryConf, self._recoveryConfPath, cb);
};


PostgresMgr.prototype._updateConf = function (options, rpath, wpath, cb) {
    var self = this;
    var log = self._log;
    log.debug({
        options: options,
        rpath: rpath,
        wpath: wpath
    }, 'updating config');

    ConfParser.read(rpath, function (err, conf) {
        if (err) {
            log.error({
                err: err,
                options: options,
                postgresConf: rpath
            }, 'unable to read config');
            return cb(err);
        }

        for (var confKey in options) {
            log.trace({
                key: confKey,
                value: options[confKey]
            }, 'writing config key');
            ConfParser.set(conf, confKey, options[confKey]);
        }

        log.debug({
            conf: conf,
            options: options,
            rpath: rpath,
            wpath: wpath
        }, 'writing configs');

        ConfParser.write(wpath, conf, cb);
    });
};


/**
 * Restarts the postgres instance. If no pg instance is running, this will just
 * start pg.
 * @param {function} callback The callback of the form f(err).
 */
PostgresMgr.prototype._restart = function (callback) {
    var self = this;
    var log = self._log;
    log.info('PostgresMgr.restart: entering');

    // check health first to see if db is running
    self._health(function (err) {
        if (err) {
            log.info('PostgresMgr.restart: db not running');
            return self._start(callback);
        } else {
            log.info('PostgresMgr.restart: db is running');
            self._stop(function (err2) {
                if (err2) {
                    return callback(err2);
                } else {
                    return self._start(callback);
                }
            });
        }
    });
};


/**
 * Check the health status of the running postgres db.
 * @param {function} callback The callback of the form f(err), where err
 * indicates an unhealthy db.
 */
PostgresMgr.prototype._health = function (callback) {
    var self = this;
    var log = self._log;
    log.trace('PostgresMgr.health: entering');
    self._queryDb('select current_time;', function (err) {
        if (err) {
            log.trace({err: err}, 'PostgresMgr.health: failed');
        }
        return callback(err);
    });
};


/**
 * check the replication status of the current pg node. returns error if
 * replication has failed.
 */
PostgresMgr.prototype._checkRepl = function (stdby) {
    var self = this;
    var log = self._log;
    var replReplayLoc = null;
    var replStartTime = Date.now();
    var timeoutId;
    log.info({standby: stdby}, 'PostgresMgr._checkRepl: entering');

    var checkReplEmitter = new EventEmitter();
    var cancel = false;
    checkReplEmitter.cancel = function () {
        log.info('PostgresMgr._checkRepl: cancelled, exiting');
        cancel = true;
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        checkReplEmitter.emit('done');
    };

    (function checkReplication() {
        self._checkReplStatus(stdby, function (err, _stop, replayLoc) {
            if (cancel) {
                return;
            }
            if (err) {
                /*
                 * If we can't query the replication state (or if we've failed
                 * to validate the LSNs provided by postgres), we just keep
                 * trying.  Importantly we do not count this as part of the
                 * replication timeout.  Generally this means the standby
                 * hasn't started or is unable to start.  This means that the
                 * standby will eventually time itself out and we will exit the
                 * loop since a new event will be emitted when the standby
                 * leaves the election.
                 */
                log.info({err: err}, 'error while querying replication status');
                // reset the start time when we get error since we haven't
                // gotten any real replication information yet.
                replStartTime = Date.now();
                timeoutId = setTimeout(checkReplication, 1000);
                return;
            } else if (!replReplayLoc ||
                mod_lsn.xlogCompare(replayLoc, replReplayLoc) > 0) {
                log.info({
                    oldReplayLoc: replReplayLoc,
                    currReplLoc: replayLoc
                }, 'replay row incremented, resetting startTime');
                replStartTime = Date.now();
                replReplayLoc = replayLoc;
            }

            var diffTime = Date.now() - replStartTime;
            // stop if caught up, return error if standby times out
            if (_stop) {
                log.info({
                    stop: _stop,
                    diffTime: diffTime,
                    oldReplayLoc: replReplayLoc,
                    currReplLoc: replayLoc
                }, 'PostgresMgr._checkRepl: done, stopping replication check');
                checkReplEmitter.emit('done');
                return;
            } else if (diffTime > self._replicationTimeout) {
                /*
                 * at this point, we've timed out trying to wait/query
                 * replication state, so we return error
                 */
                checkReplEmitter.emit('error',
                    new verror.VError('standby unable to make forward ' +
                                      'progress'));
                return;
            } else {
                log.info({
                    stop: _stop,
                    diffTime: diffTime,
                    oldReplayLoc: replReplayLoc,
                    currReplLoc: replayLoc
                }, 'continuing replication check');
                timeoutId = setTimeout(checkReplication, 1000);
                return;
            }
        });
    })();

    return checkReplEmitter;
};


PostgresMgr.prototype._checkReplStatus = function (stdby, callback) {
    var self = this;
    var log = self._log;
    var query = sprintf(PG_STAT_REPLICATION, stdby);
    log.info({standby: stdby, query: query},
             'PostgresMgr.checkReplStatus: entering');
    self._queryDb(query, function (err, result) {
        log.debug({err: err, result: result}, 'returned from query');
        if (err) {
            return callback(new verror.VError(err,
                'unable to query replication stat'));
        }

        /*
         * empty result actually returns with the timez of request hence we
         * check whether sync_state exists as well
         */
        if (!result || !result.sync_state || !result.sent_location ||
            !result.flush_location) {
            var msg = 'no replication status';
            var err2 = new verror.VError(msg);
            return callback(err2);
        }

        /*
         * We should now have enough information to compare the reported
         * locations, but first some validation on the response from postgres.
         */
        var lsnValidationErrors = [];
        [ 'sent_location', 'flush_location' ].forEach(function (location) {
            var validation = mod_lsn.xlogValidate(result[location]);
            if (validation instanceof Error) {
                lsnValidationErrors.push(new verror.VError(validation,
                    '%s is invalid', location));
            }
        });
        if (lsnValidationErrors.length > 0) {
            var lsnMultiError = new verror.MultiError(lsnValidationErrors);
            callback(new verror.VError(lsnMultiError,
                'failed to validate LSNs returned by postgres'));
            return;
        }

        var sentLocation = result.sent_location;
        var flushLocation = result.flush_location;

        log.info({
            primary: sentLocation,
            standby: flushLocation
        }, 'PostgresMgr.checkReplStatus: LSNs are');

        var lsnComparison = mod_lsn.xlogCompare(sentLocation, flushLocation);
        /*
         * If we have a primary restart with no takeover and the sync hasn't
         * restarted, the primary may be replaying its WAL but the sync has
         * always been up to date. In this case it's theoretically possible that
         * flush location is ahead of sent if replication were ever to be
         * established during this state.
         *
         * The caller of this function is responsible for taking the required
         * actions in this case, so we only compare these values for a direct
         * match and don't return whether the sync appears ahead or behind.
         */
        if (lsnComparison === 0) {
            log.info('exiting checkReplStatus: synchronous standby caught up');
            return callback(null, true, flushLocation);
        } else {
            log.info({
                row: result
            }, 'still waiting for synchronous standby to catch up');
            return callback(null, null, flushLocation);
        }

    });
};

/** #@- */
