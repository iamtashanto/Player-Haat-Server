import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const RATING_WINDOW_DAYS = 7;
export const REMINDER_AFTER_DAYS = 3;

const score = z.number().int().min(1).max(5);

/**
 * One body for both directions; the service checks which keys are required for the caller's role:
 *   captain → player : skill, punctuality, behavior   (or `noShow: true` and no scores)
 *   player  → captain: behavior, organization, and payment on paid matches only
 */
export const createRatingBody = z.strictObject({
  applicationId: z.string().min(1).max(40).optional().openapi({ description: "Captain only: which accepted player you're rating." }),
  scores: z
    .strictObject({
      skill: score.optional(),
      punctuality: score.optional(),
      behavior: score.optional(),
      payment: score.optional(),
      organization: score.optional(),
    })
    .optional(),
  comment: z.string().trim().max(500).nullable().optional(),
  noShow: z.boolean().optional().openapi({ description: "Captain only. The player was accepted but never turned up. Adds a strike; no scores." }),
});

export const requestParams = z.object({ requestId: z.string().min(1).max(40) });
export const profileParams = z.object({ id: z.string().min(1).max(40) });
export const playerRatingsQuery = pageQuery;

const Scores = z.record(z.string(), z.number());
const RatingItem = z
  .object({
    id: z.string(),
    direction: z.enum(["CAPTAIN_TO_PLAYER", "PLAYER_TO_CAPTAIN"]),
    scores: Scores,
    overall: z.number(),
    comment: z.string().nullable(),
    noShow: z.boolean(),
    createdAt: z.string().datetime(),
    revealed: z.boolean().openapi({ description: "False until both sides have rated or the 7-day window closed (double-blind)." }),
    revealsAt: z.string().datetime().nullable().optional(),
  })
  .openapi("Rating");
const PublicReview = z
  .object({
    id: z.string(),
    overall: z.number(),
    scores: Scores,
    comment: z.string().nullable(),
    reply: z.object({ text: z.string(), at: z.string().datetime().nullable() }).nullable(),
    createdAt: z.string().datetime(),
    rater: z.object({ name: z.string(), avatarUrl: z.string().nullable() }),
    request: z.object({ sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }), matchAt: z.string().datetime() }),
  })
  .openapi("PlayerReview");
const Pending = z
  .object({
    request: z.record(z.string(), z.unknown()).openapi({ description: "Same shape as a request." }),
    role: z.enum(["CAPTAIN", "PLAYER"]),
    rateBy: z.string().datetime().openapi({ description: "End of the 7-day window." }),
    targets: z.array(z.object({ applicationId: z.string().nullable(), name: z.string(), avatarUrl: z.string().nullable() })),
  })
  .openapi("PendingRating");

const T = "Ratings";
registerRoute({
  method: "post",
  path: "/requests/{requestId}/ratings",
  tag: T,
  summary: "Rate the other side of a completed match",
  description:
    `Within ${RATING_WINDOW_DAYS} days of completion. The poster rates each accepted player (send \`applicationId\`); each accepted player rates the poster. ` +
    "Ratings are final. A captain's `noShow` adds a strike to the player (and the player can then no longer rate the captain).",
  auth: true,
  params: requestParams,
  body: createRatingBody,
  response: RatingItem,
  status: 201,
  errors: [403, 404, 409, 422],
});
registerRoute({ method: "get", path: "/ratings/pending", tag: T, summary: "Matches I can still rate", description: "Completed matches inside the rating window with someone left to rate.", auth: true, response: z.array(Pending) });
registerRoute({ method: "get", path: "/players/{id}/ratings", tag: T, summary: "Reviews a player has received", description: "Excludes no-show strikes. Newest first.", auth: true, params: profileParams, query: playerRatingsQuery, response: z.array(PublicReview), errors: [404, 422] });

export const ratingParams = z.object({ id: z.string().min(1).max(40) });
export const replyBody = z.strictObject({ text: z.string().trim().min(1).max(300) });
export const disputeBody = z.strictObject({
  reason: z.string().trim().min(10).max(1000),
  photoPublicId: z.string().min(1).max(200).nullable().optional().openapi({ description: "An image you uploaded (kind: dispute evidence)." }),
});
export const resolveBody = z.strictObject({ decision: z.enum(["UPHOLD", "REMOVE"]), note: z.string().trim().min(3).max(1000) });
export const hideBody = z.strictObject({ hidden: z.boolean(), reason: z.string().trim().min(3).max(1000) });
export const reasonBody = z.strictObject({ reason: z.string().trim().min(3).max(1000) });
export const disputesQuery = pageQuery.extend({ status: z.enum(["OPEN", "UPHELD", "REMOVED"]).optional() });

const Any = z.record(z.string(), z.unknown());
const Received = z
  .object({
    id: z.string(),
    direction: z.enum(["CAPTAIN_TO_PLAYER", "PLAYER_TO_CAPTAIN"]),
    noShow: z.boolean(),
    overall: z.number().nullable(),
    scores: Scores,
    comment: z.string().nullable(),
    reply: z.object({ text: z.string(), at: z.string().datetime().nullable() }).nullable(),
    hidden: z.boolean(),
    dispute: z.object({ status: z.enum(["OPEN", "UPHELD", "REMOVED"]) }).nullable(),
    canDispute: z.boolean(),
    canReply: z.boolean(),
    createdAt: z.string().datetime(),
    rater: z.object({ name: z.string(), avatarUrl: z.string().nullable() }),
    request: z.object({ sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }), matchAt: z.string().datetime() }),
  })
  .openapi("ReceivedRating");
registerRoute({ method: "get", path: "/ratings/received", tag: T, summary: "Reviews and no-show strikes I received", description: "Revealed ones only, with reply/dispute state and whether I can still reply or dispute.", auth: true, query: playerRatingsQuery, response: z.array(Received) });
registerRoute({ method: "post", path: "/ratings/{id}/reply", tag: T, summary: "Answer a review in public", description: "One reply of at most 300 characters, editable for 24 hours after it is first posted.", auth: true, params: ratingParams, body: replyBody, response: Any, errors: [404, 409, 422] });
registerRoute({ method: "post", path: "/ratings/{id}/dispute", tag: T, summary: "Dispute a review or a no-show", description: "Within 7 days of it being revealed; a reason (10+ characters) and an optional photo. While open, a no-show strike is not counted.", auth: true, params: ratingParams, body: disputeBody, response: Any, status: 201, errors: [403, 404, 409, 422] });
