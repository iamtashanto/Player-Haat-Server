import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import hpp from "hpp";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { API_PREFIX, BODY_LIMIT } from "./config/constants.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { buildOpenApiDocument } from "./lib/openapi.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { notFoundHandler } from "./middlewares/not-found.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { apiRouter } from "./routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Behind Nginx we must trust X-Forwarded-For or every client shares one IP (and one rate-limit bucket).
  if (env.TRUST_PROXY) app.set("trust proxy", 1);

  // Request id first so every later log line and error carries it.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length <= 100 ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      // Native apps send no Origin header and are always allowed; browsers must be on the allowlist.
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(hpp());

  // Health is outside the rate limiter and outside /api/v1 so probes never get throttled or versioned.
  app.use("/health", healthRoutes);

  if (env.DOCS_ENABLED) {
    const doc = buildOpenApiDocument();
    app.get("/openapi.json", (_req, res) => res.json(doc));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: "PlayerHaat API" }));
  }

  app.use(API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
