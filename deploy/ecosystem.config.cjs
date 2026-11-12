// PM2 process file. One instance by default; read docs/DEPLOYMENT.md §7 before raising `instances`.
module.exports = {
  apps: [
    {
      name: 'tablesaas-api',
      cwd: __dirname + '/../server',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      out_file: '/var/log/tablesaas/api.out.log',
      error_file: '/var/log/tablesaas/api.err.log',
      time: true,
    },
  ],
};
