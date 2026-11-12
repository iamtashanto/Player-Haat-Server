import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./telemetry.schema.js";
import { ingest } from "./telemetry.service.js";

/** Mounted at /telemetry. Anonymous on purpose: errors on the sign-in screen matter most. */
export const telemetryRoutes = Router();
const limiter = createRateLimiter({ windowMs: 60_000, limit: 120 });
telemetryRoutes.post("/", limiter, validate({ body: s.batchBody }), async (req, res) => {
  ok(res, { accepted: await ingest(valid<z.infer<typeof s.batchBody>>(req).body) });
});
