import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { authUser } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./dashboard.schema.js";
import { getDashboard } from "./dashboard.service.js";

/** Mounted at /dashboard behind the app-user guard. */
export const dashboardRoutes = Router();
dashboardRoutes.get("/", validate({ query: s.dashboardQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.dashboardQuery>>(req);
  const { userId, role } = authUser(req);
  ok(res, await getDashboard(userId, role, query.role));
});
