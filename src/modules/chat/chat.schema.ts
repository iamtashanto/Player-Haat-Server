import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";

const id = z.string().min(1).max(40);
export const MAX_NEW_CONVERSATIONS_PER_DAY = 30;

export const openBody = z
  .strictObject({
    profileId: id.optional().openapi({ description: "Recruiters: the player's profile id." }),
    recruiterId: id.optional().openapi({ description: "Players: the recruiter's profile id (only after you've accepted each other)." }),
  })
  .refine((b) => (b.profileId === undefined) !== (b.recruiterId === undefined), { message: "Send exactly one of profileId or recruiterId", path: ["profileId"] });
export const conversationParams = z.object({ id });
export const sendBody = z.strictObject({ body: z.string().trim().min(1).max(2000) });
export const messagesQuery = z.object({
  before: id.optional().openapi({ description: "Older messages than this message id (scrolling back)." }),
  after: id.optional().openapi({ description: "Only messages newer than this id, oldest first (polling an open chat)." }),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const conversationsQuery = pageQuery;

const Message = z.object({ id: z.string(), mine: z.boolean(), body: z.string(), createdAt: z.string().datetime() });
const Conversation = z
  .object({
    id: z.string(),
    other: z.object({ name: z.string(), avatarUrl: z.string().nullable(), role: z.enum(["PLAYER", "RECRUITER"]), profileId: z.string().nullable(), recruiterId: z.string().nullable(), organization: z.string().nullable(), verified: z.boolean() }),
    lastMessageAt: z.string().datetime(),
    lastMessagePreview: z.string().nullable(),
    unread: z.number().int(),
    blockedByMe: z.boolean().openapi({ description: "Players: you've stopped this recruiter from writing." }),
  })
  .openapi("Conversation");

const T = "Chat";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/conversations", ...A, summary: "Open (or get) a conversation", description: "Recruiters can write to a player who shows their number on tap, or one they've been accepted by. Players reply in existing conversations, or open one with a recruiter they've accepted each other with.", body: openBody, response: Conversation, status: 200, errors: [403, 404, 422, 429] });
registerRoute({ method: "get", path: "/conversations", ...A, summary: "My conversations, most recent first", query: conversationsQuery, response: z.array(Conversation), errors: [422] });
registerRoute({ method: "get", path: "/conversations/{id}/messages", ...A, summary: "Messages in a conversation", description: "Newest first with `before`; or oldest first with `after` to poll an open chat every few seconds.", params: conversationParams, query: messagesQuery, response: z.array(Message), errors: [404, 422] });
registerRoute({ method: "post", path: "/conversations/{id}/messages", ...A, summary: "Send a message", description: "The other person gets a push the first time they have unread messages. 30 a minute.", params: conversationParams, body: sendBody, response: Message, status: 201, errors: [403, 404, 422, 429] });
registerRoute({ method: "post", path: "/conversations/{id}/read", ...A, summary: "Mark everything read", params: conversationParams, response: z.object({ unread: z.number().int() }), errors: [404] });
registerRoute({ method: "post", path: "/conversations/{id}/block", ...A, summary: "Stop a recruiter writing to me (players)", params: conversationParams, response: Conversation, errors: [403, 404] });
registerRoute({ method: "post", path: "/conversations/{id}/unblock", ...A, summary: "Allow them to write again (players)", params: conversationParams, response: Conversation, errors: [403, 404] });
