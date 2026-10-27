import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { requireOnboardedRecruiter } from "../recruiters/recruiters.service.js";
import * as s from "./chat.schema.js";
import * as svc from "./chat.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req);
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, B<typeof s.conversationParams>>(req).params.id;
const sendLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 30 });
const openLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });
const readLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 240 }); // polling an open chat every few seconds

/** Mounted at /conversations behind the app-user guard. */
export const chatRoutes = Router();

// A recruiter finishes onboarding before writing to anyone; a player doesn't need a recruiter profile.
chatRoutes.post("/", openLimiter, validate({ body: s.openBody }), async (req, res, next) => {
  if (me(req).role === "RECRUITER") return requireOnboardedRecruiter(req, res, next);
  next();
}, async (req, res) => {
  const { userId, role } = me(req);
  ok(res, await svc.open(userId, role as "PLAYER" | "RECRUITER", valid<B<typeof s.openBody>>(req).body));
});
chatRoutes.get("/", readLimiter, validate({ query: s.conversationsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.conversationsQuery>>(req);
  const { items, nextCursor } = await svc.list(me(req).userId, query);
  ok(res, items, { nextCursor, limit: query.limit });
});
chatRoutes.get("/:id/messages", readLimiter, validate({ params: s.conversationParams, query: s.messagesQuery }), async (req, res) => {
  const { params, query } = valid<unknown, B<typeof s.conversationParams>, B<typeof s.messagesQuery>>(req);
  ok(res, await svc.messages(me(req).userId, params.id, query));
});
chatRoutes.post("/:id/messages", sendLimiter, validate({ params: s.conversationParams, body: s.sendBody }), async (req, res) => {
  created(res, await svc.send(me(req).userId, idOf(req), valid<B<typeof s.sendBody>>(req).body.body));
});
chatRoutes.post("/:id/read", readLimiter, validate({ params: s.conversationParams }), async (req, res) => ok(res, await svc.markRead(me(req).userId, idOf(req))));
chatRoutes.post("/:id/block", requireRole("PLAYER"), validate({ params: s.conversationParams }), async (req, res) => ok(res, await svc.setBlocked(me(req).userId, idOf(req), true)));
chatRoutes.post("/:id/unblock", requireRole("PLAYER"), validate({ params: s.conversationParams }), async (req, res) => ok(res, await svc.setBlocked(me(req).userId, idOf(req), false)));
