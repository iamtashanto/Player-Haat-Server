import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { requireOnboardedRecruiter } from "../recruiters/recruiters.service.js";
import * as s from "./invites.schema.js";
import * as svc from "./invites.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, B<typeof s.inviteParams>>(req).params.id;
const sendLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 40 });
const actLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 120 });

/** Mounted at /invites behind the app-user guard. */
export const invitesRoutes = Router();

invitesRoutes.post("/", requireRole("RECRUITER"), requireOnboardedRecruiter, sendLimiter, validate({ body: s.createInviteBody }), async (req, res) => {
  created(res, await svc.createInvite(me(req), valid<B<typeof s.createInviteBody>>(req).body));
});
invitesRoutes.get("/sent", requireRole("RECRUITER"), validate({ query: s.invitesQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.invitesQuery>>(req);
  const { items, nextCursor } = await svc.listSent(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
invitesRoutes.get("/received", requireRole("PLAYER"), validate({ query: s.invitesQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.invitesQuery>>(req);
  const { items, nextCursor } = await svc.listReceived(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
invitesRoutes.post("/:id/accept", requireRole("PLAYER"), actLimiter, validate({ params: s.inviteParams }), async (req, res) => ok(res, await svc.acceptInvite(me(req), idOf(req))));
invitesRoutes.post("/:id/decline", requireRole("PLAYER"), actLimiter, validate({ params: s.inviteParams }), async (req, res) => ok(res, await svc.declineInvite(me(req), idOf(req))));
invitesRoutes.post("/:id/withdraw", requireRole("RECRUITER"), actLimiter, validate({ params: s.inviteParams }), async (req, res) => ok(res, await svc.withdrawInvite(me(req), idOf(req))));
