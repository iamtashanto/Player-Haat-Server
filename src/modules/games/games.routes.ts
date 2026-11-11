import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./games.schema.js";
import * as svc from "./games.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, B<typeof s.gameParams>>(req).params.id;
const sendLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 30 });
const readLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 240 });

/** Mounted at /games behind the app-user guard. */
export const gamesRoutes = Router();
gamesRoutes.use(requireAuth);

gamesRoutes.get("/chats", readLimiter, async (req, res) => ok(res, await svc.myChats(me(req))));
gamesRoutes.get("/:id/chat", readLimiter, validate({ params: s.gameParams }), async (req, res) => ok(res, await svc.getChat(me(req), idOf(req))));
gamesRoutes.get("/:id/chat/messages", readLimiter, validate({ params: s.gameParams, query: s.messagesQuery }), async (req, res) => {
  const { params, query } = valid<unknown, B<typeof s.gameParams>, B<typeof s.messagesQuery>>(req);
  ok(res, await svc.messages(me(req), params.id, query));
});
gamesRoutes.post("/:id/chat/messages", sendLimiter, validate({ params: s.gameParams, body: s.sendBody }), async (req, res) => {
  created(res, await svc.send(me(req), idOf(req), valid<B<typeof s.sendBody>>(req).body.body));
});
gamesRoutes.put("/:id/attendance", validate({ params: s.gameParams, body: s.attendanceBody }), async (req, res) => {
  ok(res, await svc.markAttendance(me(req), idOf(req), valid<B<typeof s.attendanceBody>>(req).body));
});
