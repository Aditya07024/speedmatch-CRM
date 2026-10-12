module.exports = {
  apps: [
    {
      name: "speedmatch-crm",
      script: "./artifacts/api-server/dist/index.mjs",
      cwd: "/var/www/CRM",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 8095,
      },
    },
  ],
};
