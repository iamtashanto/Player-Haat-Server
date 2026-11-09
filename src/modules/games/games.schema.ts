import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const id = z.string().min(1).max(40);
export const CHAT_ARCHIVE_DAYS = 7;
export const ATTENDANCE_WINDOW_DAYS = 14;

export const gameParams = z.object({ id });
export const sendBody = z.strictObject({ body: z.string().trim().min(1).max(1000) });
export const messagesQuery = z.object({
  before: id.optional().openapi({ description: "Older messages than this message id (scrolling back)." }),
  after: id.optional().openapi({ description: "Only messages newer than this id, oldest first (polling)." }),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const attendanceBody = z.strictObject({
  marks: z
    .array(z.strictObject({ applicationId: id, status: z.enum(["ATTENDED", "NO_SHOW"]) }))
    .min(1)
    .max(40),
});

const Member = z.object({ name: z.string(), avatarUrl: z.string().nullable(), isOrganiser: z.boolean() });
const Message = z.object({ id: z.string(), mine: z.boolean(), body: z.string(), createdAt: z.string().datetime(), sender: Member });
const Chat = z
  .object({
    gameId: z.string(),
    sport: z.object({ id: z.number().int(), nameBn: z.string(), nameEn: z.string() }),
    matchAt: z.string().datetime(),
    venueText: z.string(),
    status: z.enum(["OPEN", "FILLED", "CANCELLED", "COMPLETED"]),
    members: z.array(Member),
    archived: z.boolean().openapi({ description: "Read-only: 7 days after the game, or once the game is cancelled." }),
    archivesAt: z.string().datetime().nullable(),
    canPost: z.boolean(),
    lastMessageAt: z.string().datetime().nullable(),
    lastMessagePreview: z.string().nullable(),
  })
  .openapi("GameChat");
const Attendance = z.object({ items: z.array(z.object({ applicationId: z.string(), playerId: z.string(), attendance: z.enum(["ATTENDED", "NO_SHOW"]).nullable() })) }).openapi("GameAttendance");

const T = "Games";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "get", path: "/games/chats", ...A, summary: "My game chats", description: "Games I organise or have joined (accepted), soonest-active first. Created automatically with the game.", response: z.array(Chat), errors: [] });
registerRoute({ method: "get", path: "/games/{id}/chat", ...A, summary: "A game's group chat", description: "Members are the organiser and accepted players. 404 for anyone else.", params: gameParams, response: Chat, errors: [404] });
registerRoute({ method: "get", path: "/games/{id}/chat/messages", ...A, summary: "Messages in a game chat", description: "Newest first with `before`; oldest first with `after` to poll.", params: gameParams, query: messagesQuery, response: z.array(Message), errors: [404, 422] });
registerRoute({ method: "post", path: "/games/{id}/chat/messages", ...A, summary: "Post to a game chat", description: "`GAME_CHAT_ARCHIVED` once the chat is read-only. 30 a minute.", params: gameParams, body: sendBody, response: Message, status: 201, errors: [404, 409, 422, 429] });
registerRoute({ method: "put", path: "/games/{id}/attendance", ...A, summary: "Mark who turned up (organiser only)", description: `After the game starts and for ${ATTENDANCE_WINDOW_DAYS} days. Only accepted players can be marked; marking again corrects it. Feeds each player's reliability score.`, params: gameParams, body: attendanceBody, response: Attendance, errors: [403, 404, 409, 422] });
