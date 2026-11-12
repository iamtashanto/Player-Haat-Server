import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./competition.schema.js";
import * as svc from "./challenges.service.js";

const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, z.infer<typeof s.challengeParams>>(req).params.id;
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 30 });

/** Mounted at /challenges behind the app-user guard. */
export const challengesRoutes = Router();
challengesRoutes.post("/", limiter, validate({ body: s.challengeBody }), async (req, res) => created(res, await svc.create(me(req), valid<z.infer<typeof s.challengeBody>>(req).body)));
challengesRoutes.get("/mine", async (req, res) => ok(res, await svc.mine(me(req))));
challengesRoutes.get("/", validate({ query: s.challengesQuery }), async (req, res) => ok(res, await svc.list(me(req), valid<unknown, unknown, z.infer<typeof s.challengesQuery>>(req).query)));
challengesRoutes.post("/:id/accept", limiter, validate({ params: s.challengeParams, body: s.acceptBody }), async (req, res) => ok(res, await svc.accept(me(req), idOf(req), valid<z.infer<typeof s.acceptBody>>(req).body)));
challengesRoutes.post("/:id/cancel", limiter, validate({ params: s.challengeParams }), async (req, res) => ok(res, await svc.cancel(me(req), idOf(req))));
