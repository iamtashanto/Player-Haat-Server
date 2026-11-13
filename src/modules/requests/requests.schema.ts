import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const MAX_OPEN_REQUESTS = 10;
export const MAX_DAYS_AHEAD = 120;

const intId = z.number().int().positive();
const qid = z.coerce.number().int().positive();
const money = z.number().int().min(0).max(1_000_000);
/** Inside Bangladesh's bounding box: a pin outside it is a mistake, not a ground. */
export const BD_BOX = { minLat: 20.5, maxLat: 26.7, minLng: 88.0, maxLng: 92.8 } as const;
const lat = z.number().min(BD_BOX.minLat).max(BD_BOX.maxLat);
const lng = z.number().min(BD_BOX.minLng).max(BD_BOX.maxLng);
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
  joinMode: z.enum(["APPROVAL", "OPEN_JOIN"]).optional().openapi({ description: "APPROVAL (default): you accept each applicant. OPEN_JOIN: players are in as soon as they join, until the game is full (matches only)." }),
  title: z.string().trim().min(3).max(80).nullable().optional().openapi({ description: "Required for events, e.g. 'Under-17 trial, Barishal'." }),
  venueLat: lat.nullable().optional().openapi({ description: "Optional pin of the ground (both `venueLat` and `venueLng`). Shown to everyone who can see the game, so only pin the ground itself, never a home." }),
  venueLng: lng.nullable().optional(),
  groundFee: money.nullable().optional().openapi({ description: "Matches only. Total ground rent in BDT; each player's share is this divided by `playersNeeded`. Payment itself happens outside the app." }),
  feeMode: z.enum(["TOTAL", "PER_PLAYER"]).optional().openapi({ description: "TOTAL (default): `groundFee` is the whole rent, split between `playersNeeded`. PER_PLAYER: `groundFee` is what each player pays, e.g. 50." }),
  isTurf: z.boolean().optional().openapi({ description: "A turf or rented ground. Shown as a badge and filterable." }),
  feePayTo: z.string().trim().max(80).nullable().optional().openapi({ description: 'Where to send the share, e.g. "bKash 01XXXXXXXXX". Accepted players see it; nobody else.' }),
})
  .refine((b) => b.kind !== "EVENT" || !!b.title, { message: "An event needs a title", path: ["title"] })
  .refine((b) => b.kind !== "EVENT" || b.joinMode !== "OPEN_JOIN", { message: "Events can't use open join", path: ["joinMode"] })
  .refine((b) => b.kind !== "EVENT" || (b.groundFee == null && !b.feePayTo), { message: "Events have no ground fee", path: ["groundFee"] })
  .refine((b) => (b.venueLat == null) === (b.venueLng == null), { message: "Send both venueLat and venueLng, or neither", path: ["venueLng"] })
  .refine((b) => !b.feePayTo || b.groundFee != null, { message: "Set the ground fee first", path: ["feePayTo"] });

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
    groundFee: money.nullable(),
    feePayTo: z.string().trim().max(80).nullable(),
    feeMode: z.enum(["TOTAL", "PER_PLAYER"]),
    isTurf: z.boolean(),
    venueLat: lat.nullable(),
    venueLng: lng.nullable(),
  })
  .partial()
  .refine((b) => (b.venueLat === undefined) === (b.venueLng === undefined) && (b.venueLat === null) === (b.venueLng === null), { message: "Send both venueLat and venueLng (or null for both)", path: ["venueLng"] })
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
    turf: z.stringbool().optional().openapi({ description: "true: only games on a turf or rented ground." }),
    forMe: z.stringbool().optional().openapi({ description: "true: only games that fit my player profile: a sport I play, a position I play (or any position), within how far I will travel, and a fee I accept. Same rule as the new-game notifications. Ignored without a player profile." }),
    sort: z.enum(["soonest", "near"]).default("soonest").openapi({ description: "`near`: same union, then same upazila, then same district, then the rest, soonest first within each; needs `nearDistrictId`. Area ids only, no coordinates." }),
    nearDistrictId: qid.optional(),
    nearUpazilaId: qid.optional(),
    nearUnionId: qid.optional(),
  })
  .refine((q) => !q.position || q.sportId !== undefined, { message: "position requires sportId", path: ["position"] })
  .refine((q) => q.sort !== "near" || q.nearDistrictId !== undefined, { message: "sort=near requires nearDistrictId", path: ["nearDistrictId"] });

export const mapQuery = z.object({
  sportId: qid.optional(),
  districtId: qid.optional(),
  upazilaId: qid.optional(),
  kind: z.enum(["MATCH", "EVENT"]).optional(),
  turf: z.stringbool().optional(),
});

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
    captain: z.object({ name: z.string(), avatarUrl: z.string().nullable(), rating: z.object({ average: z.number(), count: z.number(), isNew: z.boolean() }), recruiterId: z.string().nullable(), recruiterVerified: z.boolean(), logoUrl: z.string().nullable() }),
    kind: z.enum(["MATCH", "EVENT"]),
    joinMode: z.enum(["APPROVAL", "OPEN_JOIN"]),
    title: z.string().nullable(),
    boostedUntil: z.string().datetime().nullable().openapi({ description: "Set while a paid boost is running; boosted requests appear in /requests/featured." }),
    interested: z.object({ count: z.number().int(), preview: z.array(z.object({ profileId: z.string(), name: z.string(), avatarUrl: z.string().nullable() })) }).openapi({ description: "People who applied / tapped 'interested' (pending or accepted). `preview` lists a few visible players, newest first, for events." }),
    isOwner: z.boolean(),
    myApplication: z.object({ id: z.string(), status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN", "WAITLISTED"]), waitlistPosition: z.number().int().optional().openapi({ description: "1 = next in line. Only while WAITLISTED." }) }).nullable(),
    pin: z.object({ lat: z.number(), lng: z.number() }).nullable().openapi({ description: "The ground's pin, when the organiser set one." }),
    areaCentre: z.object({ lat: z.number(), lng: z.number() }).nullable().openapi({ description: "Centre of the game's upazila (or district): where to centre a map when there is no pin. Approximate." }),
    isTurf: z.boolean(),
    fee: z.object({ mode: z.enum(["TOTAL", "PER_PLAYER"]), total: z.number().int().openapi({ description: "What the game collects in all: the rent, or the per-player fee times the players needed." }), share: z.number().int().openapi({ description: "BDT per player: the fee itself for PER_PLAYER, else the rent divided by players needed, rounded up." }), payTo: z.string().nullable().openapi({ description: "Only the organiser and accepted players see it." }), paidCount: z.number().int().optional().openapi({ description: "Owner only: accepted players ticked as paid." }), iPaid: z.boolean().optional().openapi({ description: "Accepted player only: the organiser has ticked my share." }) }).nullable().openapi({ description: "The ground-fee split, when the organiser set a fee." }),
    result: z.object({ ourScore: z.number().int(), theirScore: z.number().int(), opponentName: z.string().nullable(), summary: z.string().nullable(), outcome: z.enum(["WIN", "DRAW", "LOSS"]), recordedAt: z.string().datetime(), opponentTeam: z.object({ id: z.string(), name: z.string() }).nullable(), confirmed: z.boolean().openapi({ description: "The opponent team's captain confirmed the score. Only confirmed scores count in standings." }), canConfirm: z.boolean().openapi({ description: "I am the opponent captain and have not confirmed yet." }) }).nullable().openapi({ description: "The score, once the organiser has recorded it. Our side is the organiser's." }),
    series: z.object({ id: z.string(), title: z.string() }).nullable().openapi({ description: "The weekly game this match belongs to." }),
    waitlistCount: z.number().int().openapi({ description: "How many people are waiting for a spot." }),
    pendingApplicants: z.number().int().optional().openapi({ description: "Owner only." }),
    createdAt: z.string().datetime(),
  })
  .openapi("PlayerRequest");

export const resultBody = z.strictObject({
  ourScore: z.number().int().min(0).max(999),
  theirScore: z.number().int().min(0).max(999),
  opponentName: z.string().trim().max(60).nullable().optional(),
  summary: z.string().trim().max(80).nullable().optional().openapi({ description: 'Free text for sports where a number is not enough, e.g. "won by 3 wickets".' }),
  opponentTeamId: z.string().min(1).max(40).nullable().optional().openapi({ description: "A registered team of the same sport, when the match was posted for the organiser's own team. Its captain is asked to confirm; only confirmed scores count in standings." }),
});

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
registerRoute({ method: "put", path: "/requests/{id}/result", tag: T, summary: "Record the score (organiser)", description: "Only for a match that has started and was not cancelled. The organiser's side is first. Calling it again corrects the score. The players who were accepted are told the first time.", auth: true, params: requestParams, body: resultBody, response: RequestItem, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/requests/{id}/result/confirm", tag: T, summary: "Confirm the score (opponent captain)", description: "Makes the score count in both teams' standings.", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/requests/{id}/result/reject", tag: T, summary: "Reject the score (opponent captain)", description: "Unlinks the score from your team. It stays on the match but never counts in standings.", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
const MapGame = z.object({
  id: z.string(),
  lat: z.number(),
  lng: z.number(),
  exact: z.boolean().openapi({ description: "true: the organiser pinned the ground. false: the centre of the upazila (approximate)." }),
  kind: z.enum(["MATCH", "EVENT"]),
  title: z.string().nullable(),
  sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }),
  matchAt: z.string().datetime(),
  venueText: z.string(),
  spotsLeft: z.number().int(),
  isPaid: z.boolean(),
});
registerRoute({ method: "get", path: "/requests/map", tag: T, summary: "Open games as map points", description: "Open, upcoming games (up to 300) with a position: the pinned ground, else the centre of the upazila (`exact: false`). Same visibility rules as the feed, minus the person filter: your own games are included.", auth: true, query: mapQuery, response: z.array(MapGame), errors: [422] });
registerRoute({ method: "get", path: "/public/requests/map", tag: "Public", summary: "Open games as map points (signed out)", description: "Same as `GET /requests/map` without sign-in.", query: mapQuery, response: z.array(MapGame), errors: [422] });
registerRoute({ method: "get", path: "/requests/{id}/weather", tag: T, summary: "Rain outlook for the game", description: "From Open-Meteo, for the centre of the game's area (no user data is sent). `null` when the match is past, more than 14 days away, or the forecast can't be fetched.", auth: true, params: requestParams, response: z.object({ level: z.enum(["LIKELY", "POSSIBLE", "UNLIKELY"]), rainChance: z.number().int().openapi({ description: "Highest chance of rain, percent, during the two hours of play." }), rainMm: z.number() }).nullable(), errors: [404] });
registerRoute({ method: "post", path: "/requests/{id}/complete", tag: T, summary: "Mark the match completed", description: "Only after the match time and with at least one accepted player. Starts the 7-day rating window.", auth: true, params: requestParams, response: RequestItem, errors: [403, 404, 409] });
