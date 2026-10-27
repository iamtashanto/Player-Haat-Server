import { Router } from "express";
import type { z } from "zod";
import { created, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./reports.schema.js";
import * as svc from "./reports.service.js";

const limiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: 20 }); // a day's worth of reports per IP

export const reportsRoutes = Router();
reportsRoutes.post("/", requireAuth, limiter, validate({ body: s.createReportBody }), async (req, res) => {
  created(res, await svc.createReport(authUser(req).userId, valid<z.infer<typeof s.createReportBody>>(req).body));
});
