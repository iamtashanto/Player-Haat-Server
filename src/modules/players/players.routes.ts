import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { authUser, requireAuth, requireRole } from "../../middlewares/auth.js";
import { imageUpload } from "../../middlewares/upload.js";
import { validate } from "../../middlewares/validate.js";
import { uploadLimiter } from "../media/media.routes.js";
import * as contact from "../contact/contact.service.js";
import { contactViewsQuery } from "../contact/contact.schema.js";
import * as verification from "../verification/verification.service.js";
import * as vs from "../verification/verification.schema.js";
import * as media from "./player-media.service.js";
import * as svc from "./players.service.js";
import * as s from "./players.schema.js";
import { requireOnboardedRecruiter } from "../recruiters/recruiters.service.js";
import { searchPlayers } from "./search.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;

// Search is the most expensive read in the API (multi-filter SQL + hydration): 60 per minute per user.
const searchLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 60 });

export const playersRoutes = Router();
playersRoutes.use(requireAuth);

// Managing a player profile is for players only; recruiters (and players) can still search and view others.
playersRoutes.use("/me", requireRole("PLAYER"));

// ── my profile (declared before /:id so "me" is never read as an id) ──
playersRoutes.get("/me", async (req, res) => ok(res, await svc.getMyProfile(me(req))));
playersRoutes.post("/me", validate({ body: s.createProfileBody }), async (req, res) => {
  created(res, await svc.createProfile(me(req), valid<B<typeof s.createProfileBody>>(req).body));
});
playersRoutes.patch("/me", validate({ body: s.updateProfileBody }), async (req, res) => {
  ok(res, await svc.updateProfile(me(req), valid<B<typeof s.updateProfileBody>>(req).body));
});

playersRoutes.post("/me/sports", validate({ body: s.addSportBody }), async (req, res) => {
  created(res, await svc.addSport(me(req), valid<B<typeof s.addSportBody>>(req).body));
});
playersRoutes.patch("/me/sports/:sportId", validate({ params: s.sportParams, body: s.updateSportBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.updateSportBody>, B<typeof s.sportParams>>(req);
  ok(res, await svc.updateSport(me(req), params.sportId, body));
});
playersRoutes.delete("/me/sports/:sportId", validate({ params: s.sportParams }), async (req, res) => {
  ok(res, await svc.removeSport(me(req), valid<unknown, B<typeof s.sportParams>>(req).params.sportId));
});

playersRoutes.post("/me/sports/:sportId/achievements", validate({ params: s.sportParams, body: s.addAchievementBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.addAchievementBody>, B<typeof s.sportParams>>(req);
  created(res, await svc.addAchievement(me(req), params.sportId, body));
});
playersRoutes.delete("/me/sports/:sportId/achievements/:achievementId", validate({ params: s.achievementParams }), async (req, res) => {
  const { params } = valid<unknown, B<typeof s.achievementParams>>(req);
  ok(res, await svc.removeAchievement(me(req), params.sportId, params.achievementId));
});

playersRoutes.get("/me/contact-views", validate({ query: contactViewsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof contactViewsQuery>>(req);
  const { items, nextCursor } = await contact.myContactViews(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});

playersRoutes.post("/me/sports/:sportId/verification", validate({ params: vs.sportParams, body: vs.submitStatsBody }), async (req, res) => {
  const { params, body } = valid<B<typeof vs.submitStatsBody>, B<typeof vs.sportParams>>(req);
  created(res, await verification.submitStats(me(req), params.sportId, body));
});
playersRoutes.get("/me/sports/:sportId/verification", validate({ params: vs.sportParams }), async (req, res) => {
  ok(res, await verification.latestStats(me(req), valid<unknown, B<typeof vs.sportParams>>(req).params.sportId));
});

playersRoutes.post("/me/media/photos", uploadLimiter, imageUpload("file"), async (req, res) => {
  created(res, await media.addPhoto(me(req), req.image!.buffer));
});
playersRoutes.post("/me/media/videos", validate({ body: s.addVideoBody }), async (req, res) => {
  created(res, await media.addVideo(me(req), valid<B<typeof s.addVideoBody>>(req).body.url));
});
playersRoutes.put("/me/media/order", validate({ body: s.reorderBody }), async (req, res) => {
  ok(res, await media.reorderMedia(me(req), valid<B<typeof s.reorderBody>>(req).body.ids));
});
playersRoutes.delete("/me/media/:mediaId", validate({ params: s.mediaParams }), async (req, res) => {
  ok(res, await media.removeMedia(me(req), valid<unknown, B<typeof s.mediaParams>>(req).params.mediaId));
});

// ── others ──
playersRoutes.get("/", requireOnboardedRecruiter, searchLimiter, validate({ query: s.searchQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.searchQuery>>(req);
  const { items, nextCursor } = await searchPlayers(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
// Tapping "show number" (and the price check before it). Recruiters finish onboarding first, like search.
const contactLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 120 });
playersRoutes.get("/:id/contact", requireOnboardedRecruiter, validate({ params: s.profileParams }), async (req, res) => {
  ok(res, await contact.contactStatus(me(req), valid<unknown, B<typeof s.profileParams>>(req).params.id));
});
playersRoutes.post("/:id/contact", requireOnboardedRecruiter, contactLimiter, validate({ params: s.profileParams }), async (req, res) => {
  ok(res, await contact.revealContact(me(req), valid<unknown, B<typeof s.profileParams>>(req).params.id));
});
playersRoutes.get("/:id", requireOnboardedRecruiter, validate({ params: s.profileParams }), async (req, res) => {
  ok(res, await svc.getPublicProfile(valid<unknown, B<typeof s.profileParams>>(req).params.id, me(req)));
});
