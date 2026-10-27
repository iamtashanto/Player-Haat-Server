import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { authUser, requireAuth, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter, ipAndEmailKey } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import type { ConfigKey } from "../app-config/app-config.service.js";
import { adminLogin } from "../auth/auth.controller.js";
import { loginBody } from "../auth/auth.schema.js";
import * as s from "./admin.schema.js";
import * as svc from "./admin.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const adminId = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, { id: string }>(req).params.id;

export const adminRoutes = Router();

// The one unauthenticated route: the dashboard's own sign-in, throttled per IP + email like the app's.
adminRoutes.post("/auth/login", createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: ipAndEmailKey }), validate({ body: loginBody }), adminLogin);

adminRoutes.use(requireAuth, requireRole("ADMIN"), createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 600 }));

adminRoutes.get("/me", async (req, res) => ok(res, await svc.me(adminId(req))));
adminRoutes.get("/stats", async (_req, res) => ok(res, await svc.stats()));

// directories
adminRoutes.get("/players", validate({ query: s.playersQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.playersQuery>>(req);
  const { items, nextCursor } = await svc.listPlayers(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminRoutes.get("/recruiters", validate({ query: s.recruitersQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.recruitersQuery>>(req);
  const { items, nextCursor } = await svc.listRecruiters(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminRoutes.post("/recruiters/:id/verify", validate({ params: s.recruiterParams, body: s.verifyBody }), async (req, res) => {
  ok(res, await svc.setRecruiterVerified(adminId(req), idOf(req), valid<B<typeof s.verifyBody>>(req).body.verified));
});

// users
adminRoutes.put("/users/:id/role", validate({ params: s.userParams, body: s.roleBody }), async (req, res) => {
  const { body } = valid<B<typeof s.roleBody>>(req);
  ok(res, await svc.setUserRole(adminId(req), idOf(req), body.role, body.reason));
});
adminRoutes.get("/users", validate({ query: s.usersQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.usersQuery>>(req);
  const { items, nextCursor } = await svc.listUsers(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminRoutes.get("/users/:id", validate({ params: s.userParams }), async (req, res) => ok(res, await svc.getUser(idOf(req))));
adminRoutes.post("/users/:id/suspend", validate({ params: s.userParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.suspendUser(adminId(req), idOf(req), valid<B<typeof s.reasonBody>>(req).body.reason));
});
adminRoutes.post("/users/:id/unsuspend", validate({ params: s.userParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.unsuspendUser(adminId(req), idOf(req), valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});

// profiles
const profileId = (req: Parameters<typeof valid>[0]) => valid<unknown, B<typeof s.profileParams>>(req).params.profileId;
adminRoutes.post("/players/:profileId/hide", validate({ params: s.profileParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.setProfileHidden(adminId(req), profileId(req), true, valid<B<typeof s.reasonBody>>(req).body.reason));
});
adminRoutes.post("/players/:profileId/unhide", validate({ params: s.profileParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.setProfileHidden(adminId(req), profileId(req), false, valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});
adminRoutes.post("/players/:profileId/verify", validate({ params: s.profileParams, body: s.verifyBody }), async (req, res) => {
  ok(res, await svc.setProfileVerified(adminId(req), profileId(req), valid<B<typeof s.verifyBody>>(req).body.verified));
});

// sport profiles (one per sport, under a player's profile)
adminRoutes.post("/sport-profiles/:id/hide", validate({ params: s.sportProfileParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.setSportProfileHidden(adminId(req), idOf(req), true, valid<B<typeof s.reasonBody>>(req).body.reason));
});
adminRoutes.post("/sport-profiles/:id/unhide", validate({ params: s.sportProfileParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.setSportProfileHidden(adminId(req), idOf(req), false, valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});

// requests
adminRoutes.post("/requests/:id/hide", validate({ params: s.requestParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.setRequestHidden(adminId(req), idOf(req), true, valid<B<typeof s.reasonBody>>(req).body.reason));
});
adminRoutes.post("/requests/:id/unhide", validate({ params: s.requestParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.setRequestHidden(adminId(req), idOf(req), false, valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});

// reports
adminRoutes.get("/reports", validate({ query: s.reportsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.reportsQuery>>(req);
  const { items, nextCursor } = await svc.listReports(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminRoutes.get("/reports/:id", validate({ params: s.reportParams }), async (req, res) => ok(res, await svc.getReport(idOf(req))));
adminRoutes.post("/reports/:id/resolve", validate({ params: s.reportParams, body: s.resolveBody }), async (req, res) => {
  ok(res, await svc.resolveReport(adminId(req), idOf(req), valid<B<typeof s.resolveBody>>(req).body));
});

// audit log + config
adminRoutes.get("/actions", validate({ query: s.actionsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.actionsQuery>>(req);
  const { items, nextCursor } = await svc.listActions(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminRoutes.get("/app-config", async (_req, res) => ok(res, await svc.getConfig()));
adminRoutes.put("/app-config/:key", validate({ params: s.configParams, body: s.configBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.configBody>, B<typeof s.configParams>>(req);
  ok(res, await svc.setConfig(adminId(req), params.key as ConfigKey, body.value));
});
