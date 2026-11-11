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
notificationsRoutes.get("/web-push/key", async (_req, res) => ok(res, svc.webPushKey()));
notificationsRoutes.post("/web-push/subscriptions", deviceLimiter, validate({ body: s.webSubBody }), async (req, res) => {
  await svc.saveWebSubscription(me(req), valid<B<typeof s.webSubBody>>(req).body, req.get("user-agent"));
  ok(res, { success: true });
});
notificationsRoutes.delete("/web-push/subscriptions", deviceLimiter, validate({ body: s.webUnsubBody }), async (req, res) => {
  await svc.removeWebSubscription(me(req), valid<B<typeof s.webUnsubBody>>(req).body.endpoint);
  ok(res, { success: true });
});
notificationsRoutes.get("/preferences", async (req, res) => ok(res, await svc.myPreferences(me(req))));
notificationsRoutes.put("/preferences", validate({ body: s.prefsBody }), async (req, res) => {
  ok(res, await svc.savePreferences(me(req), valid<B<typeof s.prefsBody>>(req).body));
});
notificationsRoutes.delete("/", async (req, res) => ok(res, await svc.deleteAllNotifications(me(req))));
notificationsRoutes.delete("/:id", validate({ params: s.idParams }), async (req, res) => {
  ok(res, await svc.deleteNotification(me(req), valid<unknown, B<typeof s.idParams>>(req).params.id));
});
notificationsRoutes.get("/unread-count", async (req, res) => ok(res, { count: await svc.unreadCountOf(me(req)) }));
notificationsRoutes.post("/read-all", async (req, res) => ok(res, await svc.markAllRead(me(req))));
notificationsRoutes.post("/:id/read", validate({ params: s.idParams }), async (req, res) => {
  ok(res, await svc.markRead(me(req), valid<unknown, B<typeof s.idParams>>(req).params.id));
});
