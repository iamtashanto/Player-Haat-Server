import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const deviceBody = z.strictObject({
  token: z.string().trim().min(20).max(4096).openapi({ description: "FCM registration token." }),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
});
export const unregisterBody = z.strictObject({ token: deviceBody.shape.token });
export const listQuery = pageQuery.extend({ unreadOnly: z.stringbool().optional() });
export const idParams = z.object({ id: z.string().min(1).max(40) });

const NotificationItem = z
  .object({
    id: z.string(),
    type: z.enum([
      "NEW_MATCHING_REQUEST",
      "NEW_APPLICANT",
      "APPLICATION_ACCEPTED",
      "APPLICATION_REJECTED",
      "APPLICATION_WITHDRAWN",
      "REQUEST_CANCELLED",
      "REQUEST_UPDATED",
      "RATING_REMINDER",
      "SYSTEM",
    ]),
    title: z.string().openapi({ description: "Rendered in the user's locale." }),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).openapi({ description: "Deep-link ids (requestId, applicationId) and display fields." }),
    readAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Notification");

const T = "Notifications";
registerRoute({ method: "post", path: "/notifications/devices", tag: T, summary: "Register an FCM token", description: "Idempotent upsert. A token that moves to a different account is reassigned. Keeps at most 10 devices per user.", auth: true, body: deviceBody, errors: [422] });
registerRoute({ method: "delete", path: "/notifications/devices", tag: T, summary: "Unregister an FCM token (call on logout)", auth: true, body: unregisterBody, errors: [422] });
registerRoute({ method: "get", path: "/notifications", tag: T, summary: "My notifications, newest first", auth: true, query: listQuery, response: z.array(NotificationItem), errors: [422] });
registerRoute({ method: "get", path: "/notifications/unread-count", tag: T, summary: "Unread badge count", auth: true, response: z.object({ count: z.number().int() }) });
registerRoute({ method: "post", path: "/notifications/read-all", tag: T, summary: "Mark everything read", auth: true, response: z.object({ updated: z.number().int() }) });
registerRoute({ method: "post", path: "/notifications/{id}/read", tag: T, summary: "Mark one read", auth: true, params: idParams, response: NotificationItem, errors: [404] });
