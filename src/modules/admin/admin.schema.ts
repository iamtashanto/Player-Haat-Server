import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";
import { CONFIG_KEYS } from "../app-config/app-config.service.js";
import { loginBody as loginBodyRef } from "../auth/auth.schema.js";

const id = z.string().min(1).max(40);
export const userParams = z.object({ id });
export const profileParams = z.object({ profileId: id });
export const requestParams = z.object({ id });
export const reportParams = z.object({ id });
export const configParams = z.object({ key: z.enum(CONFIG_KEYS as [string, ...string[]]) });
export const intIdParams = z.object({ id: z.coerce.number().int().positive() });
export const sportProfileParams = z.object({ id });
export const recruiterParams = z.object({ id });
export const mediaParams = z.object({ id, mediaId: id });

const reason = z.string().trim().min(3).max(300);
export const reasonBody = z.strictObject({ reason });
export const optionalReasonBody = z.strictObject({ reason: reason.optional() }).default({});
export const verifyBody = z.strictObject({ verified: z.boolean() });
export const resolveBody = z.strictObject({
  outcome: z.enum(["RESOLVED", "DISMISSED"]).openapi({ description: "RESOLVED = we acted on it; DISMISSED = no action needed." }),
  resolution: z.string().trim().min(3).max(500),
});

export const roleBody = z.strictObject({
  role: z.enum(["PLAYER", "RECRUITER"]).openapi({ description: "Admins are never created or removed through the API." }),
  reason,
});
export const banUserBody = z.strictObject({
  reason,
  durationDays: z.coerce.number().int().min(1).max(365).optional().openapi({ description: "Optional ban duration in days; omitted means permanent." }),
});
export const configBody = z.strictObject({ value: z.union([z.boolean(), z.string().max(40)]) });

export const usersQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches name, email or phone." }),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  role: z.enum(["PLAYER", "RECRUITER", "ADMIN"]).optional(),
  verified: z.stringbool().optional(),
  divisionId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
  sportId: z.coerce.number().int().positive().optional(),
});

export const playersQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches the player's name or email." }),
  sportId: z.coerce.number().int().positive().optional().openapi({ description: "Only players with a profile for this sport." }),
  districtId: z.coerce.number().int().positive().optional(),
  hidden: z.stringbool().optional().openapi({ description: "true = only profiles an admin has hidden (account or any sport profile)." }),
});

export const recruitersQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches name, email or organization." }),
  verified: z.stringbool().optional(),
  districtId: z.coerce.number().int().positive().optional(),
});

export const reportsQuery = pageQuery.extend({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "ALL"]).default("OPEN"),
  targetType: z.enum(["USER", "PLAYER_PROFILE", "REQUEST", "TEAM", "RATING"]).optional(),
});

export const actionsQuery = pageQuery.extend({
  targetType: z.string().max(30).optional(),
  targetId: z.string().max(40).optional(),
  adminId: z.string().max(40).optional(),
  action: z.string().max(40).optional(),
});

// Sport profiles search & moderation
export const sportProfilesQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches player name or email." }),
  sportId: z.coerce.number().int().positive().optional(),
  position: z.string().trim().max(30).optional(),
  districtId: z.coerce.number().int().positive().optional(),
  khep: z.stringbool().optional(),
  hidden: z.stringbool().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
});

export const updateSportProfileBody = z.strictObject({
  headline: z.string().trim().max(160).nullable().optional(),
  experienceYears: z.number().int().min(0).max(60).nullable().optional(),
  currentTeam: z.string().trim().max(80).nullable().optional(),
  reason,
});

// Requests & applications moderation
export const requestsAdminQuery = pageQuery.extend({
  q: z.string().trim().min(2).max(80).optional().openapi({ description: "Matches venue or poster name." }),
  sportId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
  status: z.enum(["OPEN", "FILLED", "CANCELLED", "COMPLETED"]).optional(),
  hidden: z.stringbool().optional(),
  isPaid: z.stringbool().optional(),
});

export const cancelRequestBody = z.strictObject({ reason });

export const applicationsAdminQuery = pageQuery.extend({
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN"]).optional(),
  requestId: z.string().max(40).optional(),
  playerId: z.string().max(40).optional(),
});

// Sports and positions configuration
export const createSportBody = z.strictObject({
  code: z.string().trim().min(2).max(30).transform((s) => s.toUpperCase()),
  nameEn: z.string().trim().min(2).max(80),
  nameBn: z.string().trim().min(2).max(80),
  isActive: z.boolean().default(true),
});

export const updateSportBody = z.strictObject({
  nameEn: z.string().trim().min(2).max(80).optional(),
  nameBn: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
});

export const createPositionBody = z.strictObject({
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  nameEn: z.string().trim().min(2).max(80),
  nameBn: z.string().trim().min(2).max(80),
  order: z.number().int().default(0),
});

export const updatePositionBody = z.strictObject({
  nameEn: z.string().trim().min(2).max(80).optional(),
  nameBn: z.string().trim().min(2).max(80).optional(),
  order: z.number().int().optional(),
});

// Locations
export const updateLocationBody = z.strictObject({
  nameEn: z.string().trim().min(2).max(80).optional(),
  nameBn: z.string().trim().min(2).max(80).optional(),
});

export const districtsQuery = z.object({
  divisionId: z.coerce.number().int().positive().optional(),
});

export const upazilasQuery = z.object({
  districtId: z.coerce.number().int().positive().optional(),
});

export const unionsQuery = z.object({
  upazilaId: z.coerce.number().int().positive().optional(),
});

// Push Announcements
export const notificationFilterQuery = z.object({
  role: z.enum(["PLAYER", "RECRUITER"]).optional(),
  sportId: z.coerce.number().int().positive().optional(),
  divisionId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
});

export const broadcastNotificationBody = z.strictObject({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(3).max(500),
  role: z.enum(["PLAYER", "RECRUITER"]).optional(),
  sportId: z.coerce.number().int().positive().optional(),
  divisionId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
});

// Admin Self-Management
export const changePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128).refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Must contain a letter and a number"),
});

export const adminRefreshBody = z.strictObject({
  refreshToken: z.string().min(20).max(200).optional(),
});

const Obj = z.record(z.string(), z.unknown());
const T = "Admin";
const A = { tag: T, auth: true } as const;

registerRoute({ method: "post", path: "/admin/auth/login", tag: T, summary: "Dashboard sign-in", description: "Email + password for ADMIN accounts only.", body: loginBodyRef, response: Obj, errors: [401, 403, 422, 429] });
registerRoute({ method: "post", path: "/admin/auth/refresh", tag: T, summary: "Refresh admin session", description: "Exchanges refresh cookie or body token for a new access token.", body: adminRefreshBody, response: Obj, errors: [401, 422] });
registerRoute({ method: "post", path: "/admin/auth/logout", ...A, summary: "Admin sign-out", description: "Revokes the active refresh token family and clears the cookie.", response: Obj, errors: [401] });
registerRoute({ method: "get", path: "/admin/me", ...A, summary: "The signed-in admin", response: Obj, errors: [403] });
registerRoute({ method: "put", path: "/admin/me/password", ...A, summary: "Change admin password", body: changePasswordBody, response: Obj, errors: [401, 403, 422] });
registerRoute({ method: "get", path: "/admin/stats", ...A, summary: "Platform overview & analytics", description: "Metrics, charts, trends, geographical distribution, and activity feeds.", response: Obj, errors: [403] });
registerRoute({ method: "get", path: "/admin/players", ...A, summary: "Player profiles with their sport profiles", query: playersQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/recruiters", ...A, summary: "Recruiter profiles", query: recruitersQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "post", path: "/admin/recruiters/{id}/verify", ...A, summary: "Grant or remove a recruiter's verified badge", params: recruiterParams, body: verifyBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "put", path: "/admin/users/{id}/role", ...A, summary: "Switch an account between player and recruiter", params: userParams, body: roleBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/admin/users", ...A, summary: "Find users", query: usersQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/users/{id}", ...A, summary: "User detail 360 with full profiles, activity and history", params: userParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/users/{id}/suspend", ...A, summary: "Suspend a user", params: userParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/users/{id}/unsuspend", ...A, summary: "Lift a suspension", params: userParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/users/{id}/ban", ...A, summary: "Ban a user with optional duration", params: userParams, body: banUserBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/users/{id}/reset-sessions", ...A, summary: "Force logout user across all devices", params: userParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "delete", path: "/admin/users/{id}", ...A, summary: "Soft delete a user account", params: userParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/hide", ...A, summary: "Hide a player profile", params: profileParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/unhide", ...A, summary: "Unhide a player profile", params: profileParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/players/{profileId}/verify", ...A, summary: "Grant or remove the verified badge", params: profileParams, body: verifyBody, response: Obj, errors: [403, 404, 422] });

// Sport profiles
registerRoute({ method: "get", path: "/admin/sport-profiles", ...A, summary: "List and filter sport profiles across all sports", query: sportProfilesQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/sport-profiles/{id}", ...A, summary: "Get single sport profile details", params: sportProfileParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "patch", path: "/admin/sport-profiles/{id}", ...A, summary: "Moderate sport profile headline/bio", params: sportProfileParams, body: updateSportProfileBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "delete", path: "/admin/sport-profiles/{id}/media/{mediaId}", ...A, summary: "Remove inappropriate player media", params: mediaParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/sport-profiles/{id}/hide", ...A, summary: "Hide one sport profile", params: sportProfileParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/sport-profiles/{id}/unhide", ...A, summary: "Unhide a sport profile", params: sportProfileParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });

// Requests & Applications
registerRoute({ method: "get", path: "/admin/requests", ...A, summary: "Browse and filter recruitment requests", query: requestsAdminQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/requests/{id}", ...A, summary: "Get recruitment request with applicants", params: requestParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/requests/{id}/hide", ...A, summary: "Hide a request", params: requestParams, body: reasonBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/requests/{id}/unhide", ...A, summary: "Unhide a request", params: requestParams, body: optionalReasonBody, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/requests/{id}/cancel", ...A, summary: "Cancel a request as admin", params: requestParams, body: cancelRequestBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/admin/applications", ...A, summary: "Browse applications", query: applicationsAdminQuery, response: z.array(Obj), errors: [403, 422] });

// Reports
registerRoute({ method: "get", path: "/admin/reports", ...A, summary: "Report queue", query: reportsQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/reports/{id}", ...A, summary: "Report detail with the reported target and history", params: reportParams, response: Obj, errors: [403, 404] });
registerRoute({ method: "post", path: "/admin/reports/{id}/resolve", ...A, summary: "Resolve or dismiss a report", params: reportParams, body: resolveBody, response: Obj, errors: [403, 404, 409, 422] });

// Configuration: Sports & Positions
registerRoute({ method: "get", path: "/admin/sports", ...A, summary: "Get all sports with positions and counts", response: z.array(Obj), errors: [403] });
registerRoute({ method: "post", path: "/admin/sports", ...A, summary: "Create a new sport", body: createSportBody, response: Obj, errors: [403, 409, 422] });
registerRoute({ method: "put", path: "/admin/sports/{id}", ...A, summary: "Update a sport", params: intIdParams, body: updateSportBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "post", path: "/admin/sports/{id}/positions", ...A, summary: "Add a position to a sport", params: intIdParams, body: createPositionBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "put", path: "/admin/positions/{id}", ...A, summary: "Update a position", params: intIdParams, body: updatePositionBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "delete", path: "/admin/positions/{id}", ...A, summary: "Delete a position", params: intIdParams, response: Obj, errors: [403, 404, 409] });

// Configuration: Locations
registerRoute({ method: "get", path: "/admin/locations/divisions", ...A, summary: "Get divisions list", response: z.array(Obj), errors: [403] });
registerRoute({ method: "put", path: "/admin/locations/divisions/{id}", ...A, summary: "Update division name", params: intIdParams, body: updateLocationBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/admin/locations/districts", ...A, summary: "Get districts list", query: districtsQuery, response: z.array(Obj), errors: [403] });
registerRoute({ method: "put", path: "/admin/locations/districts/{id}", ...A, summary: "Update district name", params: intIdParams, body: updateLocationBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/admin/locations/upazilas", ...A, summary: "Get upazilas list", query: upazilasQuery, response: z.array(Obj), errors: [403] });
registerRoute({ method: "put", path: "/admin/locations/upazilas/{id}", ...A, summary: "Update upazila name", params: intIdParams, body: updateLocationBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/admin/locations/unions", ...A, summary: "Get unions list", query: unionsQuery, response: z.array(Obj), errors: [403] });
registerRoute({ method: "put", path: "/admin/locations/unions/{id}", ...A, summary: "Update union name", params: intIdParams, body: updateLocationBody, response: Obj, errors: [403, 404, 422] });

// Push Announcements
registerRoute({ method: "get", path: "/admin/notifications/preview", ...A, summary: "Preview recipient count for broadcast", query: notificationFilterQuery, response: z.object({ targetCount: z.number().int() }), errors: [403] });
registerRoute({ method: "post", path: "/admin/notifications/broadcast", ...A, summary: "Broadcast announcement notification", body: broadcastNotificationBody, response: z.object({ sentCount: z.number().int() }), errors: [403, 422] });

// Audit & Config
registerRoute({ method: "get", path: "/admin/actions", ...A, summary: "Moderation audit log", query: actionsQuery, response: z.array(Obj), errors: [403, 422] });
registerRoute({ method: "get", path: "/admin/app-config", ...A, summary: "All config values", response: Obj, errors: [403] });
registerRoute({ method: "put", path: "/admin/app-config/{key}", ...A, summary: "Set a config value", params: configParams, body: configBody, response: Obj, errors: [403, 422] });
