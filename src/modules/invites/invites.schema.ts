import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";

const id = z.string().min(1).max(40);
export const MAX_INVITES_PER_DAY = 30;
export const DECLINE_COOLDOWN_DAYS = 7;

export const createInviteBody = z.strictObject({
  profileId: id,
  sportId: z.number().int().positive().optional().openapi({ description: "Which of the player's sport profiles you're inviting them for. Defaults to the event's sport." }),
  requestId: id.optional().openapi({ description: "One of your own events or requests this invitation is for." }),
  message: z.string().trim().min(1).max(300).optional(),
});
export const inviteParams = z.object({ id });
export const invitesQuery = pageQuery.extend({ status: z.enum(["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN"]).optional() });

const Person = z.object({ name: z.string(), avatarUrl: z.string().nullable() });
const Invite = z
  .object({
    id: z.string(),
    status: z.enum(["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN"]),
    message: z.string().nullable(),
    createdAt: z.string().datetime(),
    respondedAt: z.string().datetime().nullable(),
    sport: z.object({ id: z.number(), code: z.string(), nameBn: z.string(), nameEn: z.string() }).nullable(),
    request: z.object({ id: z.string(), kind: z.enum(["MATCH", "EVENT"]), title: z.string().nullable(), matchAt: z.string().datetime(), venueText: z.string() }).nullable(),
    recruiter: Person.extend({ recruiterId: z.string().nullable(), organization: z.string().nullable(), type: z.string().nullable(), verified: z.boolean() }).optional().openapi({ description: "Received invites: who invited me." }),
    player: Person.extend({ profileId: z.string() }).optional().openapi({ description: "Sent invites: who I invited." }),
    contact: z.object({ phone: z.string().nullable() }).optional().openapi({ description: "Only once ACCEPTED: the other person's number." }),
  })
  .openapi("Invite");

const T = "Invites";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/invites", ...A, summary: "Invite a player (recruiters)", description: `Up to ${MAX_INVITES_PER_DAY} a day; one open invite per player; a declined player isn't re-invited for ${DECLINE_COOLDOWN_DAYS} days. The player is notified.`, body: createInviteBody, response: Invite, status: 201, errors: [403, 404, 409, 422, 429] });
registerRoute({ method: "get", path: "/invites/sent", ...A, summary: "Invites I sent (recruiters)", query: invitesQuery, response: z.array(Invite), errors: [403, 422] });
registerRoute({ method: "get", path: "/invites/received", ...A, summary: "Invites I received (players)", query: invitesQuery, response: z.array(Invite), errors: [403, 422] });
registerRoute({ method: "post", path: "/invites/{id}/accept", ...A, summary: "Accept an invite (players)", description: "Both sides now see each other's number, whatever the player's privacy setting, and can chat.", params: inviteParams, response: Invite, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/invites/{id}/decline", ...A, summary: "Decline an invite (players)", params: inviteParams, response: Invite, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/invites/{id}/withdraw", ...A, summary: "Withdraw an invite I sent (recruiters)", params: inviteParams, response: Invite, errors: [403, 404, 409] });
