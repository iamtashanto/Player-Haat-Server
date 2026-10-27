import type { Request, Response } from "express";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { ok } from "../../lib/http.js";
import { checkDatabase } from "./health.service.js";

/** Liveness: the process is up. Never touches the DB, so a DB outage doesn't make PM2/Nginx restart us. */
export function liveness(_req: Request, res: Response) {
  ok(res, { status: "ok", uptimeSec: Math.round(process.uptime()) });
}

/** Readiness: the process can serve traffic (DB reachable). */
export async function readiness(_req: Request, res: Response) {
  const db = await checkDatabase();
  if (!db.ok) {
    throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 503, "Database unreachable");
  }
  ok(res, { status: "ok", db });
}
