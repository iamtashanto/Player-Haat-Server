import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";
import { CONFIG_KEYS } from "../app-config/app-config.service.js";

const id = z.string().min(1).max(40);
export const userParams = z.object({ id });
export const profileParams = z.object({ profileId: id });
export const requestParams = z.object({ id });
export const reportParams = z.object({ id });
export const configParams = z.object({ key: z.enum(CONFIG_KEYS as [string, ...string[]]) });

const reason = z.string().trim().min(3).max(300);
export const reasonBody = z.strictObject({ reason });
export const optionalReasonBody = z.strictObject({ reason: reason.optional() }).default({});
export const verifyBody = z.strictObject({ verified: z.boolean() });
export const resolveBody = z.strictObject({
  outcome: z.enum(["RESOLVED", "DISMISSED"]).openapi({ description: "RESOLVED = we acted on it; DISMISSED = no action needed." }),
  resolution: z.string().trim().min(3).max(500),
});
export const configBody = z.strictObject({ value: z.union([z.boolean(), z.string().max(40)]) });

export const usersQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches name, email or phone." }),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  role: z.enum(["USER", "ADMIN"]).optional(),
});
export const reportsQuery = pageQuery.extend({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "ALL"]).default("OPEN"),
  targetType: z.enum(["USER", "PLAYER_PROFILE", "REQUEST", "TEAM", "RATING"]).optional(),
});
export const actionsQuery = pageQuery.extend({
  targetType: z.string().max(30).optional(),
  targetId: z.string().max(40).optional(),
  adminId: z.string().max(40).optional(),
});

const Obj = z.record(z.string(), z.unknown());
const T = "Admin";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "get", path: "/admin/users", ...A, summary: "Find users", query: usersQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/users/{id}", ...A, summary: "User detail with profile and counts", params: userParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/users/{id}/suspend", ...A, summary: "Suspend a user", description: "Blocks sign-in and revokes sessions. Their upcoming requests are cancelled and their applications withdrawn; the people affected are notified. Admins can't be suspended.", params: userParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/users/{id}/unsuspend", ...A, summary: "Lift a suspension", description: "Doesn't restore cancelled requests or withdrawn applications.", params: userParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/hide", ...A, summary: "Hide a player profile", description: "Removes it from search, public view and matching. The player can't undo it.", params: profileParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/unhide", ...A, summary: "Unhide a player profile", params: profileParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/verify", ...A, summary: "Grant or remove the verified badge", params: profileParams, body: verifyBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "post", path: "/admin/requests/{id}/hide", ...A, summary: "Hide a request", params: requestParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/requests/{id}/unhide", ...A, summary: "Unhide a request", params: requestParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "get", path: "/admin/reports", ...A, summary: "Report queue", description: "Defaults to OPEN, oldest first. Other statuses are newest first.", query: reportsQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/reports/{id}", ...A, summary: "Report detail with the reported target and history", params: reportParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/reports/{id}/resolve", ...A, summary: "Resolve or dismiss a report", description: "Records the outcome only; use the hide / suspend actions to act on the target.", params: reportParams, body: resolveBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/admin/actions", ...A, summary: "Moderation audit log", query: actionsQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/app-config", ...A, summary: "All config values", response: Obj, errors: [403] });
registerRoute({ method: "put", path: "/admin/app-config/{key}", ...A, summary: "Set a config value", description: `Keys: ${CONFIG_KEYS.join(", ")}. Takes effect for new requests immediately on this instance; others within 30s.`, params: configParams, body: configBody, response: Obj, errors: [403, 422] });
