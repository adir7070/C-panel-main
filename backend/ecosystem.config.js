module.exports = {
  apps: [
    {
      name: "iconiq-server",
      script: "./server.js",
      cwd: "/var/www/iconiq-backend",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 8000,
      listen_timeout: 15000,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        PORT: 3900,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3900,
      },
      out_file: "/home/ubuntu/.pm2/logs/iconiq-server-out.log",
      error_file: "/home/ubuntu/.pm2/logs/iconiq-server-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
