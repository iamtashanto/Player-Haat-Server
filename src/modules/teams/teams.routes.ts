import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./teams.schema.js";
import * as svc from "./teams.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, B<typeof s.teamParams>>(req).params.id;
// Codes are short, so guessing is capped hard per user.
const joinLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 20 });
const createLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 20 });

/** Mounted at /teams behind the app-user guard. */
export const teamsRoutes = Router();

teamsRoutes.post("/", createLimiter, validate({ body: s.createTeamBody }), async (req, res) => created(res, await svc.create(me(req), valid<B<typeof s.createTeamBody>>(req).body)));
// Static paths before "/:id".
teamsRoutes.get("/mine", async (req, res) => ok(res, await svc.mine(me(req))));
teamsRoutes.post("/join", requireRole("PLAYER"), joinLimiter, validate({ body: s.joinBody }), async (req, res) => ok(res, await svc.join(me(req), valid<B<typeof s.joinBody>>(req).body)));
teamsRoutes.get("/:id", validate({ params: s.teamParams }), async (req, res) => ok(res, await svc.get(me(req), idOf(req))));
teamsRoutes.patch("/:id", validate({ params: s.teamParams, body: s.updateTeamBody }), async (req, res) => ok(res, await svc.update(me(req), idOf(req), valid<B<typeof s.updateTeamBody>>(req).body)));
teamsRoutes.post("/:id/join-code", validate({ params: s.teamParams }), async (req, res) => ok(res, await svc.resetCode(me(req), idOf(req))));
teamsRoutes.post("/:id/leave", validate({ params: s.teamParams }), async (req, res) => ok(res, await svc.leave(me(req), idOf(req))));
teamsRoutes.delete("/:id/members/:memberId", validate({ params: s.memberParams }), async (req, res) => {
  const { params } = valid<unknown, B<typeof s.memberParams>>(req);
  ok(res, await svc.removeMember(me(req), params.id, params.memberId));
});
teamsRoutes.delete("/:id", validate({ params: s.teamParams }), async (req, res) => ok(res, await svc.remove(me(req), idOf(req))));
