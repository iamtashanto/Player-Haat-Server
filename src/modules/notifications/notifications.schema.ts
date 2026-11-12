import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const deviceBody = z.strictObject({
  token: z.string().trim().min(20).max(4096).openapi({ description: "FCM registration token." }),
  platform: z.enum(["ANDROID", "IOS"]).openapi({ description: "FCM is for the apps. Browsers use `/notifications/web-push/subscriptions`." }),
});
export const unregisterBody = z.strictObject({ token: deviceBody.shape.token });
export const listQuery = pageQuery.extend({ unreadOnly: z.stringbool().optional() });
export const idParams = z.object({ id: z.string().min(1).max(40) });

const NotificationItem = z
  .object({
    id: z.string(),
    type: z.enum([
      "NEW_MATCHING_REQUEST", "NEW_APPLICANT", "APPLICATION_ACCEPTED", "APPLICATION_REJECTED", "APPLICATION_WITHDRAWN",
      "REQUEST_CANCELLED", "REQUEST_UPDATED", "REQUEST_FILLED", "WAITLIST_PROMOTED", "SERIES_GAME_POSTED", "GAME_REMINDER", "RATING_REMINDER", "NEARBY_AVAILABLE",
      "NEW_MESSAGE", "GAME_MESSAGE", "INVITE_RECEIVED", "INVITE_ACCEPTED", "INVITE_DECLINED", "CONTACT_VIEWED", "PROFILE_VIEWED",
      "VERIFICATION_RESULT", "TEAM_JOINED", "SYSTEM", "ANNOUNCEMENT",
    ]),
    category: z.enum(["games", "messages", "recruitment", "system"]).openapi({ description: "The group the user can switch off; also the Android channel." }),
    link: z.string().openapi({ description: "In-app path this notification opens (the same value is in the push's data as `link`)." }),
    title: z.string().openapi({ description: "Rendered in the user's locale." }),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).openapi({ description: "Deep-link ids (requestId, applicationId) and display fields." }),
    readAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Notification");

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
export const prefsBody = z
  .strictObject({
    games: z.boolean(),
    messages: z.boolean(),
    recruitment: z.boolean(),
    system: z.boolean(),
    profileViewed: z.boolean().openapi({ description: "\"A recruiter viewed your profile\" (needs `recruitment` on)." }),
    nearbyAvailable: z.boolean().openapi({ description: "\"Someone near you is free to play today\"; also needs `games` on." }),
    quietHoursEnabled: z.boolean(),
    quietStart: HHMM.openapi({ description: "Asia/Dhaka. Default 23:00." }),
    quietEnd: HHMM.openapi({ description: "Asia/Dhaka. Default 07:00. The window may wrap past midnight." }),
    chatInQuietHours: z.boolean().openapi({ description: "Let chat messages through during quiet hours." }),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one setting");
const Prefs = z.object({ games: z.boolean(), messages: z.boolean(), recruitment: z.boolean(), system: z.boolean(), nearbyAvailable: z.boolean(), profileViewed: z.boolean(), quietHoursEnabled: z.boolean(), quietStart: z.string(), quietEnd: z.string(), chatInQuietHours: z.boolean() }).openapi("NotificationPreferences");

export const webSubBody = z.strictObject({
  endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "endpoint must be https"),
  keys: z.strictObject({ p256dh: z.string().min(20).max(256), auth: z.string().min(8).max(128) }),
});
export const webUnsubBody = z.strictObject({ endpoint: z.string().url().max(2048) });

const T = "Notifications";
registerRoute({ method: "post", path: "/notifications/devices", tag: T, summary: "Register an FCM token", description: "Idempotent upsert. A token that moves to a different account is reassigned. Keeps at most 10 devices per user.", auth: true, body: deviceBody, errors: [422] });
registerRoute({ method: "delete", path: "/notifications/devices", tag: T, summary: "Unregister an FCM token (call on logout)", auth: true, body: unregisterBody, errors: [422] });
registerRoute({ method: "get", path: "/notifications", tag: T, summary: "My notifications, newest first", auth: true, query: listQuery, response: z.array(NotificationItem), errors: [422] });
registerRoute({ method: "get", path: "/notifications/unread-count", tag: T, summary: "Unread badge count", auth: true, response: z.object({ count: z.number().int() }) });
registerRoute({ method: "post", path: "/notifications/read-all", tag: T, summary: "Mark everything read", auth: true, response: z.object({ updated: z.number().int() }) });
registerRoute({ method: "post", path: "/notifications/{id}/read", tag: T, summary: "Mark one read", auth: true, params: idParams, response: NotificationItem, errors: [404] });
registerRoute({ method: "delete", path: "/notifications/{id}", tag: T, summary: "Delete one notification", auth: true, params: idParams, response: z.object({ deleted: z.number().int() }), errors: [404] });
registerRoute({ method: "delete", path: "/notifications", tag: T, summary: "Clear my inbox", auth: true, response: z.object({ deleted: z.number().int() }) });
registerRoute({ method: "get", path: "/notifications/preferences", tag: T, summary: "What I get notified about, and quiet hours", description: "Defaults when never saved: everything on, quiet hours 23:00–07:00 Asia/Dhaka. Switching a group off stops the push; the inbox still keeps the message.", auth: true, response: Prefs });
registerRoute({ method: "put", path: "/notifications/preferences", tag: T, summary: "Change notification preferences", description: "Send only what changes.", auth: true, body: prefsBody, response: Prefs, errors: [422] });
registerRoute({ method: "get", path: "/notifications/web-push/key", tag: T, summary: "The VAPID public key for browser push", description: "`publicKey` is null when web push isn't configured on this server.", auth: true, response: z.object({ publicKey: z.string().nullable() }) });
registerRoute({ method: "post", path: "/notifications/web-push/subscriptions", tag: T, summary: "Save this browser's push subscription", description: "Idempotent by endpoint; a subscription that moves to another account is reassigned. At most 10 per user. Expired ones are removed when the push service answers 404/410.", auth: true, body: webSubBody, errors: [422, 503] });
registerRoute({ method: "delete", path: "/notifications/web-push/subscriptions", tag: T, summary: "Remove this browser's push subscription", auth: true, body: webUnsubBody, errors: [422] });
