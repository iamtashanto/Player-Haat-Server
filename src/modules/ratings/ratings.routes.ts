import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./ratings.schema.js";
import * as svc from "./ratings.service.js";

const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const rateLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });

/** Mounted at /requests/:requestId/ratings */
export const requestRatingsRoutes = Router({ mergeParams: true });
requestRatingsRoutes.post("/", requireAuth, rateLimiter, validate({ params: s.requestParams, body: s.createRatingBody }), async (req, res) => {
  const { params, body } = valid<z.infer<typeof s.createRatingBody>, z.infer<typeof s.requestParams>>(req);
  created(res, await svc.createRating(me(req), params.requestId, body));
});

/** Mounted at /ratings */
export const ratingsRoutes = Router();
ratingsRoutes.get("/pending", requireAuth, async (req, res) => ok(res, await svc.pendingRatings(me(req))));

/** Mounted at /players/:id/ratings (before the players router so `:id` isn't swallowed) */
export const playerRatingsRoutes = Router({ mergeParams: true });
playerRatingsRoutes.get("/", requireAuth, validate({ params: s.profileParams, query: s.playerRatingsQuery }), async (req, res) => {
  const { params, query } = valid<unknown, z.infer<typeof s.profileParams>, z.infer<typeof s.playerRatingsQuery>>(req);
  const { items, nextCursor } = await svc.playerReviews(params.id, query);
  ok(res, items, { nextCursor, limit: query.limit });
});
