module.exports = {
  apps: [{
    name: 'qmr-kss',
    cwd: '/opt/qmr',
    script: 'server.mjs',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    kill_timeout: 5000,
    restart_delay: 3000,
    time: true,
    output: '/opt/qmr/logs/app.log',
    error: '/opt/qmr/logs/error.log',
    env: {
      NODE_ENV: 'production',
      QMR_HOST: '0.0.0.0',
      QMR_PORT: '3509',
      QMR_DB_PATH: '/opt/qmr/data/qmr.db',
      QMR_UPLOAD_DIR: '/opt/qmr/data/uploads',
      QMR_DEMO_MODE: '0',
      QMR_SECURE_COOKIE: '0'
    }
  }]
};
