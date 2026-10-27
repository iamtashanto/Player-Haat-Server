/**
 * PM2 process file. (.cjs, not .js: package.json is "type": "module", and PM2 loads this with require().)
 *
 *   npm ci && npm run build && npx prisma migrate deploy
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup           # survive reboots
 *   pm2 reload playerhaat-api         # zero-downtime deploy (waits for each worker's "ready")
 *
 * WEB_CONCURRENCY = number of workers (default 2; use your vCPU count). Each worker keeps its own
 * Postgres pool, so keep  workers × connection_limit  comfortably below Postgres max_connections.
 */
module.exports = {
  apps: [
    {
      name: "playerhaat-api",
      script: "dist/server.js",
      cwd: __dirname,
      exec_mode: "cluster",
      instances: Number(process.env.WEB_CONCURRENCY) || 2,

      // zero-downtime reload: the server sends process.send("ready") once it is listening
      wait_ready: true,
      listen_timeout: 15_000,
      // the app drains connections for up to 10s on SIGINT/SIGTERM, so give it a little longer
      kill_timeout: 12_000,

      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      max_memory_restart: "600M", // safety net against a leak, not a tuning knob

      time: true, // timestamp PM2's own log lines
      merge_logs: true, // one log file for all workers (the app logs JSON via pino, with request ids)
      out_file: "logs/api.out.log",
      error_file: "logs/api.err.log",

      env: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production", TRUST_PROXY: "1" }, // Nginx is in front
    },
  ],
};
