/**
 * pm2 process definition. Committed on purpose — everything the worker needs is
 * in config.js, so there is nothing per-server or secret to generate here.
 */

module.exports = {
  apps: [{
    name: 'migrater',
    script: 'index.js',

    // Never cluster mode: instances would share one work/ directory, and the
    // second would refuse to start on the lockfile. To use more of a machine,
    // raise CONCURRENCY in config.js.
    exec_mode: 'fork',
    instances: 1,

    autorestart: true,
    max_memory_restart: '1G',

    // Room for the shutdown path to hand back tasks that have cost nothing yet.
    // pm2's default of 1600ms would SIGKILL first.
    kill_timeout: 10000,

    // A crash loop backs off instead of hammering the API.
    exp_backoff_restart_delay: 1000,

    time: true,
  }],
};
