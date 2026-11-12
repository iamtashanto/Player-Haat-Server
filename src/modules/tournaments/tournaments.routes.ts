import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./tournaments.schema.js";
import * as svc from "./tournaments.service.js";

const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, z.infer<typeof s.tournamentParams>>(req).params.id;
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });

/** Mounted at /tournaments behind the app-user guard. */
export const tournamentsRoutes = Router();
tournamentsRoutes.post("/", limiter, validate({ body: s.createTournamentBody }), async (req, res) => created(res, await svc.create(me(req), valid<z.infer<typeof s.createTournamentBody>>(req).body)));
tournamentsRoutes.get("/", validate({ query: s.tournamentsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.tournamentsQuery>>(req);
  const { items, nextCursor } = await svc.list(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
tournamentsRoutes.get("/:id", validate({ params: s.tournamentParams }), async (req, res) => ok(res, await svc.get(me(req), idOf(req))));
tournamentsRoutes.post("/:id/teams", limiter, validate({ params: s.tournamentParams, body: s.registerBody }), async (req, res) => ok(res, await svc.registerTeam(me(req), idOf(req), valid<z.infer<typeof s.registerBody>>(req).body.teamId)));
tournamentsRoutes.delete("/:id/teams/:teamId", limiter, validate({ params: s.entryParams }), async (req, res) => {
  const { params } = valid<unknown, z.infer<typeof s.entryParams>>(req);
  ok(res, await svc.removeTeam(me(req), params.id, params.teamId));
});
tournamentsRoutes.post("/:id/start", limiter, validate({ params: s.tournamentParams }), async (req, res) => ok(res, await svc.start(me(req), idOf(req))));
tournamentsRoutes.put("/:id/matches/:matchId", limiter, validate({ params: s.matchParams, body: s.scoreBody }), async (req, res) => {
  const { params, body } = valid<z.infer<typeof s.scoreBody>, z.infer<typeof s.matchParams>>(req);
  ok(res, await svc.enterScore(me(req), params.id, params.matchId, body));
});
tournamentsRoutes.post("/:id/cancel", limiter, validate({ params: s.tournamentParams }), async (req, res) => ok(res, await svc.cancel(me(req), idOf(req))));
