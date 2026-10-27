import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const MAX_OPEN_REQUESTS = 10;
export const MAX_DAYS_AHEAD = 120;

const intId = z.number().int().positive();
const qid = z.coerce.number().int().positive();
const money = z.number().int().min(0).max(1_000_000);
const positions = z.array(z.string().trim().min(1).max(20)).max(6);

export const createRequestBody = z.strictObject({
  sportId: intId,
  matchAt: z.string().datetime({ offset: true }).openapi({ example: "2026-11-05T16:00:00+06:00", description: "ISO-8601; must be in the future." }),
  venueText: z.string().trim().min(1).max(200),
  districtId: intId,
  upazilaId: intId,
  unionId: intId.nullable().optional(),
  positionsNeeded: positions.optional().openapi({ description: "Position codes for the sport. Empty = any position." }),
  playersNeeded: z.number().int().min(1).max(30).optional(),
  isPaid: z.boolean().optional(),
  budgetMin: money.nullable().optional(),
  budgetMax: money.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  teamId: z.string().min(1).max(40).nullable().optional(),
  kind: z.enum(["MATCH", "EVENT"]).optional().openapi({ description: "MATCH (default): players apply. EVENT: a recruiter's trial or camp — players tap 'interested'. Events are for recruiters and need a `title`." }),
  title: z.string().trim().min(3).max(80).nullable().optional().openapi({ description: "Required for events, e.g. 'Under-17 trial, Barishal'." }),
}).refine((b) => b.kind !== "EVENT" || !!b.title, { message: "An event needs a title", path: ["title"] });

// Sport and location are fixed once posted: players were matched and notified on them.
export const updateRequestBody = z
  .strictObject({
    matchAt: z.string().datetime({ offset: true }),
    venueText: z.string().trim().min(1).max(200),
    positionsNeeded: positions,
    playersNeeded: z.number().int().min(1).max(30),
    isPaid: z.boolean(),
    budgetMin: money.nullable(),
    budgetMax: money.nullable(),
    notes: z.string().trim().max(500).nullable(),
    title: z.string().trim().min(3).max(80),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field");

export const requestParams = z.object({ id: z.string().min(1).max(40) });

export const feedQuery = pageQuery
  .extend({
    sportId: qid.optional(),
    position: z.string().trim().min(1).max(20).optional().openapi({ description: "Also matches requests open to any position. Requires sportId." }),
    districtId: qid.optional(),
    upazilaId: qid.optional(),
    unionId: qid.optional(),
    isPaid: z.stringbool().optional(),
    kind: z.enum(["MATCH", "EVENT"]).optional().openapi({ description: "Only matches, or only events (recruiters' trials and camps)." }),
  })
  .refine((q) => !q.position || q.sportId !== undefined, { message: "position requires sportId", path: ["position"] });

export const featuredQuery = z.object({
  kind: z.enum(["MATCH", "EVENT"]).optional(),
  sportId: qid.optional(),
  districtId: qid.optional(),
  upazilaId: qid.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const mineQuery = pageQuery.extend({ status: z.enum(["OPEN", "FILLED", "CANCELLED", "COMPLETED"]).optional() });

// ── OpenAPI ──
const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const RequestItem = z
  .object({
    id: z.string(),
    status: z.enum(["OPEN", "FILLED", "CANCELLED", "COMPLETED"]),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
    matchAt: z.string().datetime(),
    venueText: z.string(),
    location: z.object({ district: Ref, upazila: Ref, union: Ref.nullable() }),
    positionsNeeded: z.array(z.string()),
    playersNeeded: z.number().int(),
    playersAccepted: z.number().int(),
    spotsLeft: z.number().int(),
    isPaid: z.boolean(),
    budgetMin: z.number().nullable(),
    budgetMax: z.number().nullable(),
    notes: z.string().nullable(),
    team: z.object({ id: z.string(), name: z.string(), logoUrl: z.string().nullable() }).nullable(),
    captain: z.object({ name: z.string(), avatarUrl: z.string().nullable(), rating: z.object({ average: z.number(), count: z.number() }), recruiterId: z.string().nullable(), recruiterVerified: z.boolean() }),
    kind: z.enum(["MATCH", "EVENT"]),
    title: z.string().nullable(),
    boostedUntil: z.string().datetime().nullable().openapi({ description: "Set while a paid boost is running; boosted requests appear in /requests/featured." }),
    interested: z.object({ count: z.number().int(), preview: z.array(z.object({ profileId: z.string(), name: z.string(), avatarUrl: z.string().nullable() })) }).openapi({ description: "People who applied / tapped 'interested' (pending or accepted). `preview` lists a few visible players, newest first, for events." }),
    isOwner: z.boolean(),
    myApplication: z.object({ id: z.string(), status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN"]) }).nullable(),
    pendingApplicants: z.number().int().optional().openapi({ description: "Owner only." }),
    createdAt: z.string().datetime(),
  })
  .openapi("PlayerRequest");

const T = "Requests";
registerRoute({ method: "post", path: "/requests", tag: T, summary: "Post a 'player needed' request", description: `Matching players (sport, position, khep/budget, travel radius) are notified. Max ${MAX_OPEN_REQUESTS} open upcoming requests per user.`, auth: true, body: createRequestBody, response: RequestItem, status: 201, errors: [409, 422] });
registerRoute({ method: "get", path: "/requests", tag: T, summary: "Open upcoming requests (feed)", description: "Soonest match first. Excludes my own, hidden ones and past matches.", auth: true, query: feedQuery as unknown as z.ZodObject, response: z.array(RequestItem), errors: [422] });
registerRoute({ method: "get", path: "/requests/featured", tag: T, summary: "Boosted requests", description: "Paid boosts that are running now, newest boost first. Same visibility rules as the feed.", auth: true, query: featuredQuery, response: z.array(RequestItem), errors: [422] });
registerRoute({ method: "post", path: "/requests/{id}/boost", tag: T, summary: "Boost my request (costs credits)", description: "Features it for a while (price and duration are in /app-config → pricing). Boosting again extends the time. 402 `CREDITS_REQUIRED` if you can't afford it.", auth: true, params: requestParams, response: RequestItem, errors: [402, 403, 404, 409] });
registerRoute({ method: "get", path: "/requests/mine", tag: T, summary: "Requests I posted", auth: true, query: mineQuery, response: z.array(RequestItem), errors: [422] });
registerRoute({ method: "get", path: "/requests/{id}", tag: T, summary: "One request", auth: true, params: requestParams, response: RequestItem, errors: [404] });
registerRoute({ method: "patch", path: "/requests/{id}", tag: T, summary: "Edit my request (OPEN or FILLED)", description: "Sport and location can't change — cancel and repost. Accepted players are notified of time/venue changes. `playersNeeded` can't drop below the accepted count; changing it re-opens or fills the request accordingly.", auth: true, params: requestParams, body: updateRequestBody, response: RequestItem, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/requests/{id}/cancel", tag: T, summary: "Cancel my request", description: "Notifies accepted and pending applicants; pending applications become REJECTED.", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/requests/{id}/fill", tag: T, summary: "Mark as filled (close applications early)", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/requests/{id}/complete", tag: T, summary: "Mark the match completed", description: "Only after the match time and with at least one accepted player. Starts the 7-day rating window.", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
