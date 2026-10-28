import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter, ipAndEmailKey } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import type { ConfigKey } from "../app-config/app-config.service.js";
import * as auth from "../auth/auth.service.js";
import { loginBody } from "../auth/auth.schema.js";
import { logout, rotateRefreshToken } from "../auth/token.service.js";
import * as adminAuth from "./admin-auth.service.js";
import { clearRefreshCookie, parseCookie, setRefreshCookie } from "./admin-auth.cookie.js";
import * as s from "./admin.schema.js";
import * as svc from "./admin.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const adminId = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, { id: string }>(req).params.id;
const intIdOf = (req: Parameters<typeof valid>[0]) => valid<unknown, { id: number }>(req).params.id;

export const adminRoutes = Router();

// ───────────────────────── Unauthenticated Auth Routes ─────────────────────────

adminRoutes.post(
  "/auth/login",
  createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: ipAndEmailKey }),
  validate({ body: loginBody }),
  async (req, res) => {
    const { body } = valid<B<typeof loginBody>>(req);
    const user = await auth.checkAdminCredentials(body);
    if (env.ADMIN_REQUIRE_2FA) {
      // The password alone never opens a session: the next step is a code from the authenticator app.
      ok(res, await adminAuth.beginChallenge(user));
      return;
    }
    const session = await auth.startAdminSession(user, { deviceId: body.deviceId, userAgent: req.headers["user-agent"] });
    setRefreshCookie(res, session.tokens.refreshToken);
    ok(res, session);
  },
);

adminRoutes.post("/auth/refresh", validate({ body: s.adminRefreshBody }), async (req, res) => {
  const { body } = valid<B<typeof s.adminRefreshBody>>(req);
  const token = body?.refreshToken || parseCookie(req, "ph_admin_refresh");
  if (!token) throw AppError.unauthorized("AUTH_NO_REFRESH_TOKEN", "Refresh token missing");
  const tokens = await rotateRefreshToken(token, { userAgent: req.headers["user-agent"] });
  setRefreshCookie(res, tokens.refreshToken);
  ok(res, { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
});

adminRoutes.post("/auth/logout", validate({ body: s.adminRefreshBody }), async (req, res) => {
  const { body } = valid<B<typeof s.adminRefreshBody>>(req);
  const token = body?.refreshToken || parseCookie(req, "ph_admin_refresh");
  if (token) await logout(token).catch(() => undefined);
  clearRefreshCookie(res);
  ok(res, { success: true });
});

// ───────────────────────── Protected Admin Routes ─────────────────────────

adminRoutes.use(requireAuth, requireRole("ADMIN"), createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 1200 }));

adminRoutes.get("/me", async (req, res) => ok(res, await svc.me(adminId(req))));
adminRoutes.put("/me/password", validate({ body: s.changePasswordBody }), async (req, res) => {
  const { body } = valid<B<typeof s.changePasswordBody>>(req);
  ok(res, await svc.changeAdminPassword(adminId(req), body.currentPassword, body.newPassword));
});
adminRoutes.get("/stats", async (_req, res) => ok(res, await svc.stats()));

// ───────────────────────── Users ─────────────────────────

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

adminRoutes.post("/users/:id/ban", validate({ params: s.userParams, body: s.banUserBody }), async (req, res) => {
  ok(res, await svc.banUser(adminId(req), idOf(req), valid<B<typeof s.banUserBody>>(req).body));
});

adminRoutes.post("/users/:id/reset-sessions", validate({ params: s.userParams }), async (req, res) => {
  ok(res, await svc.resetUserSessions(adminId(req), idOf(req)));
});

adminRoutes.delete("/users/:id", validate({ params: s.userParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.deleteUser(adminId(req), idOf(req), valid<B<typeof s.reasonBody>>(req).body.reason));
});

adminRoutes.put("/users/:id/role", validate({ params: s.userParams, body: s.roleBody }), async (req, res) => {
  const { body } = valid<B<typeof s.roleBody>>(req);
  ok(res, await svc.setUserRole(adminId(req), idOf(req), body.role, body.reason));
});

// ───────────────────────── Players & Recruiters ─────────────────────────

adminRoutes.get("/players", validate({ query: s.playersQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.playersQuery>>(req);
  const { items, nextCursor } = await svc.listPlayers(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

adminRoutes.post("/players/:profileId/hide", validate({ params: s.profileParams, body: s.reasonBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.reasonBody>, B<typeof s.profileParams>>(req);
  ok(res, await svc.setPlayerProfileHidden(adminId(req), params.profileId, true, body.reason));
});

adminRoutes.post("/players/:profileId/unhide", validate({ params: s.profileParams, body: s.optionalReasonBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.optionalReasonBody>, B<typeof s.profileParams>>(req);
  ok(res, await svc.setPlayerProfileHidden(adminId(req), params.profileId, false, body.reason));
});

adminRoutes.post("/players/:profileId/verify", validate({ params: s.profileParams, body: s.verifyBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.verifyBody>, B<typeof s.profileParams>>(req);
  ok(res, await svc.setPlayerProfileVerified(adminId(req), params.profileId, body.verified));
});

adminRoutes.get("/recruiters", validate({ query: s.recruitersQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.recruitersQuery>>(req);
  const { items, nextCursor } = await svc.listRecruiters(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

adminRoutes.post("/recruiters/:id/verify", validate({ params: s.recruiterParams, body: s.verifyBody }), async (req, res) => {
  ok(res, await svc.setRecruiterVerified(adminId(req), idOf(req), valid<B<typeof s.verifyBody>>(req).body.verified));
});

// ───────────────────────── Sport Profiles Directory & Moderation ─────────────────────────

adminRoutes.get("/sport-profiles", validate({ query: s.sportProfilesQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.sportProfilesQuery>>(req);
  const { items, nextCursor } = await svc.listSportProfiles(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

adminRoutes.get("/sport-profiles/:id", validate({ params: s.sportProfileParams }), async (req, res) => {
  ok(res, await svc.getSportProfile(idOf(req)));
});

adminRoutes.patch("/sport-profiles/:id", validate({ params: s.sportProfileParams, body: s.updateSportProfileBody }), async (req, res) => {
  ok(res, await svc.updateSportProfile(adminId(req), idOf(req), valid<B<typeof s.updateSportProfileBody>>(req).body));
});

adminRoutes.delete("/sport-profiles/:id/media/:mediaId", validate({ params: s.mediaParams }), async (req, res) => {
  const { params } = valid<unknown, B<typeof s.mediaParams>>(req);
  ok(res, await svc.deleteSportMedia(adminId(req), params.id, params.mediaId));
});

adminRoutes.post("/sport-profiles/:id/hide", validate({ params: s.sportProfileParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.setSportProfileHidden(adminId(req), idOf(req), true, valid<B<typeof s.reasonBody>>(req).body.reason));
});

adminRoutes.post("/sport-profiles/:id/unhide", validate({ params: s.sportProfileParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.setSportProfileHidden(adminId(req), idOf(req), false, valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});

// ───────────────────────── Requests & Applications ─────────────────────────

adminRoutes.get("/requests", validate({ query: s.requestsAdminQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.requestsAdminQuery>>(req);
  const { items, nextCursor } = await svc.listRequests(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

adminRoutes.get("/requests/:id", validate({ params: s.requestParams }), async (req, res) => {
  ok(res, await svc.getRequest(idOf(req)));
});

adminRoutes.post("/requests/:id/hide", validate({ params: s.requestParams, body: s.reasonBody }), async (req, res) => {
  ok(res, await svc.setRequestHidden(adminId(req), idOf(req), true, valid<B<typeof s.reasonBody>>(req).body.reason));
});

adminRoutes.post("/requests/:id/unhide", validate({ params: s.requestParams, body: s.optionalReasonBody }), async (req, res) => {
  ok(res, await svc.setRequestHidden(adminId(req), idOf(req), false, valid<B<typeof s.optionalReasonBody>>(req).body.reason));
});

adminRoutes.post("/requests/:id/cancel", validate({ params: s.requestParams, body: s.cancelRequestBody }), async (req, res) => {
  ok(res, await svc.cancelRequest(adminId(req), idOf(req), valid<B<typeof s.cancelRequestBody>>(req).body.reason));
});

adminRoutes.get("/applications", validate({ query: s.applicationsAdminQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.applicationsAdminQuery>>(req);
  const { items, nextCursor } = await svc.listApplications(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

// ───────────────────────── Reports ─────────────────────────

adminRoutes.get("/reports", validate({ query: s.reportsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.reportsQuery>>(req);
  const { items, nextCursor } = await svc.listReports(query);
  ok(res, items, { nextCursor, limit: query.limit });
});

adminRoutes.get("/reports/:id", validate({ params: s.reportParams }), async (req, res) => ok(res, await svc.getReport(idOf(req))));

adminRoutes.post("/reports/:id/resolve", validate({ params: s.reportParams, body: s.resolveBody }), async (req, res) => {
  ok(res, await svc.resolveReport(adminId(req), idOf(req), valid<B<typeof s.resolveBody>>(req).body));
});

// ───────────────────────── Sports & Positions Configuration ─────────────────────────

adminRoutes.get("/sports", async (_req, res) => ok(res, await svc.listSports()));

adminRoutes.post("/sports", validate({ body: s.createSportBody }), async (req, res) => {
  created(res, await svc.createSport(adminId(req), valid<B<typeof s.createSportBody>>(req).body));
});

adminRoutes.put("/sports/:id", validate({ params: s.intIdParams, body: s.updateSportBody }), async (req, res) => {
  ok(res, await svc.updateSport(adminId(req), intIdOf(req), valid<B<typeof s.updateSportBody>>(req).body));
});

adminRoutes.post("/sports/:id/positions", validate({ params: s.intIdParams, body: s.createPositionBody }), async (req, res) => {
  created(res, await svc.createPosition(adminId(req), intIdOf(req), valid<B<typeof s.createPositionBody>>(req).body));
});

adminRoutes.put("/positions/:id", validate({ params: s.intIdParams, body: s.updatePositionBody }), async (req, res) => {
  ok(res, await svc.updatePosition(adminId(req), intIdOf(req), valid<B<typeof s.updatePositionBody>>(req).body));
});

adminRoutes.delete("/positions/:id", validate({ params: s.intIdParams }), async (req, res) => {
  ok(res, await svc.deletePosition(adminId(req), intIdOf(req)));
});

// ───────────────────────── Locations Configuration ─────────────────────────

adminRoutes.get("/locations/divisions", async (_req, res) => ok(res, await svc.listDivisions()));

adminRoutes.put("/locations/divisions/:id", validate({ params: s.intIdParams, body: s.updateLocationBody }), async (req, res) => {
  ok(res, await svc.updateDivision(adminId(req), intIdOf(req), valid<B<typeof s.updateLocationBody>>(req).body));
});

adminRoutes.get("/locations/districts", validate({ query: s.districtsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.districtsQuery>>(req);
  ok(res, await svc.listDistricts(query.divisionId));
});

adminRoutes.put("/locations/districts/:id", validate({ params: s.intIdParams, body: s.updateLocationBody }), async (req, res) => {
  ok(res, await svc.updateDistrict(adminId(req), intIdOf(req), valid<B<typeof s.updateLocationBody>>(req).body));
});

adminRoutes.get("/locations/upazilas", validate({ query: s.upazilasQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.upazilasQuery>>(req);
  ok(res, await svc.listUpazilas(query.districtId));
});

adminRoutes.put("/locations/upazilas/:id", validate({ params: s.intIdParams, body: s.updateLocationBody }), async (req, res) => {
  ok(res, await svc.updateUpazila(adminId(req), intIdOf(req), valid<B<typeof s.updateLocationBody>>(req).body));
});

adminRoutes.get("/locations/unions", validate({ query: s.unionsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.unionsQuery>>(req);
  ok(res, await svc.listUnions(query.upazilaId));
});

adminRoutes.put("/locations/unions/:id", validate({ params: s.intIdParams, body: s.updateLocationBody }), async (req, res) => {
  ok(res, await svc.updateUnion(adminId(req), intIdOf(req), valid<B<typeof s.updateLocationBody>>(req).body));
});

// ───────────────────────── Push Announcements ─────────────────────────

adminRoutes.get("/notifications/preview", validate({ query: s.notificationFilterQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.notificationFilterQuery>>(req);
  ok(res, await svc.previewNotificationCount(query));
});

adminRoutes.post("/notifications/broadcast", validate({ body: s.broadcastNotificationBody }), async (req, res) => {
  const { body } = valid<B<typeof s.broadcastNotificationBody>>(req);
  ok(res, await svc.broadcastNotification(adminId(req), body));
});

// ───────────────────────── Audit Log & App Config ─────────────────────────

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
