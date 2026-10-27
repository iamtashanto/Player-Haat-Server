import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./notifications.schema.js";
import * as svc from "./notifications.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const deviceLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 });

export const notificationsRoutes = Router();
notificationsRoutes.use(requireAuth);

notificationsRoutes.post("/devices", deviceLimiter, validate({ body: s.deviceBody }), async (req, res) => {
  await svc.registerDevice(me(req), valid<B<typeof s.deviceBody>>(req).body);
  ok(res, { success: true });
});
notificationsRoutes.delete("/devices", deviceLimiter, validate({ body: s.unregisterBody }), async (req, res) => {
  await svc.unregisterDevice(me(req), valid<B<typeof s.unregisterBody>>(req).body.token);
  ok(res, { success: true });
});

notificationsRoutes.get("/", validate({ query: s.listQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.listQuery>>(req);
  const { items, nextCursor, unreadCount } = await svc.listNotifications(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit, unreadCount });
});
notificationsRoutes.get("/unread-count", async (req, res) => ok(res, { count: await svc.unreadCountOf(me(req)) }));
notificationsRoutes.post("/read-all", async (req, res) => ok(res, await svc.markAllRead(me(req))));
notificationsRoutes.post("/:id/read", validate({ params: s.idParams }), async (req, res) => {
  ok(res, await svc.markRead(me(req), valid<unknown, B<typeof s.idParams>>(req).params.id));
});
