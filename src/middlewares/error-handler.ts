import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { AppError, ErrorCode } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

interface Normalized {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function normalize(err: unknown): Normalized {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }

  if (err instanceof ZodError) {
    return {
      status: 422,
      code: ErrorCode.VALIDATION_ERROR,
      message: "Request validation failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 unique violation, P2025 record not found. Anything else is a bug → 500.
    if (err.code === "P2002") {
      return {
        status: 409,
        code: ErrorCode.CONFLICT,
        message: "Resource already exists",
        details: { target: err.meta?.target },
      };
    }
    if (err.code === "P2025") {
      return { status: 404, code: ErrorCode.NOT_FOUND, message: "Resource not found" };
    }
  }

  // body-parser / http-errors style errors carry a numeric `status` and a `type`.
  const e = err as { status?: number; type?: string };
  if (e?.type === "entity.too.large") {
    return { status: 413, code: ErrorCode.PAYLOAD_TOO_LARGE, message: "Request body too large" };
  }
  if (e?.type === "entity.parse.failed") {
    return { status: 400, code: ErrorCode.MALFORMED_JSON, message: "Malformed JSON body" };
  }

  return { status: 500, code: ErrorCode.INTERNAL_ERROR, message: "Internal server error" };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const n = normalize(err);

  if (n.status >= 500) {
    // req.log carries the request id; fall back to the root logger if pino-http didn't run.
    (req.log ?? logger).error({ err }, "unhandled error");
  }

  res.status(n.status).json({
    error: {
      code: n.code,
      message: n.message,
      ...(n.details !== undefined && { details: n.details }),
      // Stack traces are a development convenience only — never in production.
      ...(!env.isProd && n.status >= 500 && err instanceof Error && { stack: err.stack }),
    },
  });
};
