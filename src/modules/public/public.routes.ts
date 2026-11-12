import { Router } from "express";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { ok, valid } from "../../lib/http.js";
import { registerRoute } from "../../lib/openapi.js";
import { z as zod } from "../../lib/zod.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { profileParams, searchQuery } from "../players/players.schema.js";
import { searchPlayers } from "../players/search.service.js";
import { getPublicProfile } from "../players/players.service.js";
import { feedQuery, requestParams } from "../requests/requests.schema.js";
import { feed, getRequest } from "../requests/requests.service.js";
import { publicPlayerReviews } from "../ratings/ratings.service.js";
import { playerRatingsQuery } from "../ratings/ratings.schema.js";
import { RATING_RULES } from "../ratings/ratings.config.js";
import * as tournaments from "../tournaments/tournaments.service.js";
import { tournamentParams, tournamentsQuery } from "../tournaments/tournaments.schema.js";
import { leaderboard, publicTeam } from "../competition/standings.service.js";
import { leaderboardQuery, publicTeamParams, publicTeamQuery } from "../competition/competition.schema.js";

/**
 * Read-only, signed-out views of what the public website shows for search engines and shared links: the same data
 * as the app's endpoints for a viewer with no account (hidden/suspended players and requests stay hidden; no contact
 * details are ever returned). Tight per-IP limits because anyone can call these.
 */
const limiter = createRateLimiter({ windowMs: 60 * 1000, limit: 60 });

export const publicRoutes = Router();

publicRoutes.get("/players", limiter, validate({ query: searchQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof searchQuery>>(req);
  const { items, nextCursor } = await searchPlayers("", query);
  ok(res, items, { nextCursor, limit: query.limit });
});
/** "Top rated": only people with enough revealed reviews, best damped rating first. */
publicRoutes.get("/top-players", limiter, validate({ query: searchQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof searchQuery>>(req);
  const { items, nextCursor } = await searchPlayers("", { ...query, sort: "rating", minReviews: RATING_RULES.minRevealedForAverage });
  ok(res, items, { nextCursor, limit: query.limit });
});
publicRoutes.get("/players/:id", limiter, validate({ params: profileParams }), async (req, res) => {
  ok(res, await getPublicProfile(valid<unknown, z.infer<typeof profileParams>>(req).params.id));
});
publicRoutes.get("/players/:id/reviews", limiter, validate({ params: profileParams, query: playerRatingsQuery }), async (req, res) => {
  const { params, query } = valid<unknown, z.infer<typeof profileParams>, z.infer<typeof playerRatingsQuery>>(req);
  const { items, nextCursor } = await publicPlayerReviews(params.id, query);
  ok(res, items, { nextCursor, limit: query.limit });
});
publicRoutes.get("/leaderboard", limiter, validate({ query: leaderboardQuery }), async (req, res) => {
  ok(res, await leaderboard(valid<unknown, unknown, z.infer<typeof leaderboardQuery>>(req).query));
});
publicRoutes.get("/teams/:id", limiter, validate({ params: publicTeamParams, query: publicTeamQuery }), async (req, res) => {
  const { params, query } = valid<unknown, z.infer<typeof publicTeamParams>, z.infer<typeof publicTeamQuery>>(req);
  ok(res, await publicTeam(params.id, query.period));
});
publicRoutes.get("/tournaments", limiter, validate({ query: tournamentsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof tournamentsQuery>>(req);
  const { items, nextCursor } = await tournaments.list(null, query);
  ok(res, items, { nextCursor, limit: query.limit });
});
publicRoutes.get("/tournaments/:id", limiter, validate({ params: tournamentParams }), async (req, res) => ok(res, await tournaments.get(null, valid<unknown, z.infer<typeof tournamentParams>>(req).params.id)));
publicRoutes.get("/requests", limiter, validate({ query: feedQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof feedQuery>>(req);
  const { items, nextCursor } = await feed("", query);
  ok(res, items, { nextCursor, limit: query.limit });
});
publicRoutes.get("/requests/:id", limiter, validate({ params: requestParams }), async (req, res) => {
  const r = await getRequest("", valid<unknown, z.infer<typeof requestParams>>(req).params.id);
  // Signed-out visitors only ever see requests that are still open and upcoming (not filled, cancelled, finished or past).
  if (r.status !== "OPEN" || new Date(r.matchAt).getTime() <= Date.now()) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  ok(res, r);
});

const T = "Public";
registerRoute({ method: "get", path: "/public/top-players", tag: T, summary: "Top rated players (signed out)", description: "Only players with at least 3 revealed reviews, ordered by the damped rating. Same filters and shape as `/public/players`.", query: searchQuery as unknown as zod.ZodObject, response: zod.array(zod.unknown()), errors: [422] });
registerRoute({ method: "get", path: "/public/players", tag: T, summary: "Search players (signed out)", description: "Same filters and result shape as `GET /players`, without sign-in. For the website's SEO pages.", query: searchQuery as unknown as zod.ZodObject, response: zod.array(zod.unknown()), errors: [422] });
registerRoute({ method: "get", path: "/public/players/{id}", tag: T, summary: "A player's public profile (signed out)", description: "Same as `GET /players/{id}` without sign-in.", params: profileParams, response: zod.unknown(), errors: [404] });
registerRoute({ method: "get", path: "/public/requests", tag: T, summary: "Open requests (signed out)", description: "Same as `GET /requests` without sign-in.", query: feedQuery as unknown as zod.ZodObject, response: zod.array(zod.unknown()), errors: [422] });
registerRoute({ method: "get", path: "/public/requests/{id}", tag: T, summary: "One request (signed out)", description: "Same as `GET /requests/{id}` without sign-in, but only for open, upcoming requests (anything else is 404).", params: requestParams, response: zod.unknown(), errors: [404] });
