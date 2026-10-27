import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startJobs } from "./lib/jobs.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { flushBackground } from "./modules/notifications/notifier.js";

async function main() {
  await prisma.$connect(); // fail fast if the DB is unreachable
  const app = createApp();

  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "PlayerHaat API listening");
    if (env.DOCS_ENABLED) logger.info(`Swagger UI: ${env.PUBLIC_API_URL}/docs`);
    process.send?.("ready"); // tells PM2 (wait_ready) this worker is serving, so `pm2 reload` is zero-downtime
  });

  // PM2 cluster mode numbers workers 0..n-1 in NODE_APP_INSTANCE: only worker 0 runs the scheduled jobs.
  const runsJobs = env.JOBS_ENABLED && (process.env.NODE_APP_INSTANCE ?? "0") === "0";
  const stopJobs = runsJobs ? startJobs() : () => undefined;

  // Behind Nginx: Node must keep idle upstream connections open LONGER than Nginx does (its default is 60s),
  // otherwise Nginx can reuse a socket Node is just closing and the client gets a spurious 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000; // slow phone uploading a 5 MB photo is fine; a stalled connection isn't

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    stopJobs();

    // Hard stop if connections refuse to drain (keep-alive clients etc).
    const killer = setTimeout(() => {
      logger.error("forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    killer.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, "error closing http server");
      await flushBackground(); // let in-flight notifications finish before the DB goes away
      await prisma.$disconnect();
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandledRejection"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
