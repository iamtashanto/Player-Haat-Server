import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { lockRequest } from "../requests/request-lock.js";
import { ATTENDANCE_WINDOW_DAYS, CHAT_ARCHIVE_DAYS, type attendanceBody, type messagesQuery } from "./games.schema.js";

const DAY = 86_400_000;
const NOT_FOUND = () => AppError.notFound("GAME_CHAT_NOT_FOUND", "Game chat not found");

type Game = Prisma.PlayerRequestGetPayload<{
  include: {
    sport: { select: { id: true; code: true; nameBn: true; nameEn: true } };
    createdBy: { select: { id: true; name: true; avatarUrl: true; status: true } };
    applications: { where: { status: "ACCEPTED" }; select: { playerId: true; player: { select: { name: true; avatarUrl: true } } } };
  };
}>;

const gameInclude = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  createdBy: { select: { id: true, name: true, avatarUrl: true, status: true } },
  applications: { where: { status: "ACCEPTED" as const }, select: { playerId: true, player: { select: { name: true, avatarUrl: true } } } },
} satisfies Prisma.PlayerRequestInclude;

/** When the chat turns read-only: 7 days after the game (or its completion, if later). Cancelled games are read-only at once. */
export function archivesAt(g: { matchAt: Date; completedAt: Date | null }): Date {
  const base = Math.max(g.matchAt.getTime(), g.completedAt?.getTime() ?? 0);
  return new Date(base + CHAT_ARCHIVE_DAYS * DAY);
}
export const isArchived = (g: { status: string; matchAt: Date; completedAt: Date | null }, now = new Date()) =>
  g.status === "CANCELLED" || archivesAt(g).getTime() <= now.getTime();

const isMember = (g: Game, userId: string) => g.createdById === userId || g.applications.some((a) => a.playerId === userId);

/** Loads a game chat for a member. Everyone else — and events, and moderated games — gets a plain 404. */
async function loadForMember(userId: string, id: string): Promise<Game> {
  const g = await prisma.playerRequest.findUnique({ where: { id }, include: gameInclude });
  if (!g || g.kind !== "MATCH" || g.isHidden || !isMember(g, userId)) throw NOT_FOUND();
  return g;
}

function members(g: Game) {
  return [
    { name: g.createdBy.name, avatarUrl: g.createdBy.avatarUrl, isOrganiser: true },
    ...g.applications.map((a) => ({ name: a.player.name, avatarUrl: a.player.avatarUrl, isOrganiser: false })),
  ];
}

async function present(g: Game, userId: string, now = new Date()) {
  const last = await prisma.gameMessage.findFirst({ where: { requestId: g.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { body: true, createdAt: true } });
  const archived = isArchived(g, now);
  return {
    gameId: g.id,
    sport: g.sport,
    matchAt: g.matchAt.toISOString(),
    venueText: g.venueText,
    status: g.status,
    members: members(g),
    archived,
    archivesAt: g.status === "CANCELLED" ? null : archivesAt(g).toISOString(),
    canPost: !archived && g.createdBy.status === "ACTIVE" && isMember(g, userId),
    lastMessageAt: last?.createdAt.toISOString() ?? null,
    lastMessagePreview: last?.body.slice(0, 80) ?? null,
  };
}

export async function getChat(userId: string, id: string) {
  return present(await loadForMember(userId, id), userId);
}

export async function myChats(userId: string) {
  const games = await prisma.playerRequest.findMany({
    where: { kind: "MATCH", isHidden: false, OR: [{ createdById: userId }, { applications: { some: { playerId: userId, status: "ACCEPTED" } } }], matchAt: { gt: new Date(Date.now() - (CHAT_ARCHIVE_DAYS + 30) * DAY) } },
    include: gameInclude,
    orderBy: [{ matchAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const out = await Promise.all(games.map((g) => present(g, userId)));
  // Live chats first (soonest game first), archived ones after.
  return out.sort((a, b) => Number(a.archived) - Number(b.archived) || (a.archived ? Date.parse(b.matchAt) - Date.parse(a.matchAt) : Date.parse(a.matchAt) - Date.parse(b.matchAt)));
}

type MessageRow = { id: string; senderId: string; body: string; createdAt: Date; sender: { name: string; avatarUrl: string | null } };
const messageInclude = { sender: { select: { name: true, avatarUrl: true } } } as const;
const toMessage = (m: MessageRow, userId: string, organiserId: string) => ({
  id: m.id,
  mine: m.senderId === userId,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
  sender: { name: m.sender.name, avatarUrl: m.sender.avatarUrl, isOrganiser: m.senderId === organiserId },
});

export async function messages(userId: string, id: string, q: z.infer<typeof messagesQuery>) {
  const g = await loadForMember(userId, id);
  const present = (rows: MessageRow[]) => rows.map((m) => toMessage(m, userId, g.createdById));
  if (q.after) {
    const a = await prisma.gameMessage.findFirst({ where: { id: q.after, requestId: id }, select: { createdAt: true, id: true } });
    if (!a) throw AppError.invalid("after", "Unknown message");
    return present(
      await prisma.gameMessage.findMany({
        where: { requestId: id, OR: [{ createdAt: { gt: a.createdAt } }, { createdAt: a.createdAt, id: { gt: a.id } }] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: q.limit,
        include: messageInclude,
      }),
    );
  }
  const a = q.before ? await prisma.gameMessage.findFirst({ where: { id: q.before, requestId: id }, select: { createdAt: true, id: true } }) : null;
  if (q.before && !a) throw AppError.invalid("before", "Unknown message");
  return present(
    await prisma.gameMessage.findMany({
      where: { requestId: id, ...(a && { OR: [{ createdAt: { lt: a.createdAt } }, { createdAt: a.createdAt, id: { lt: a.id } }] }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit,
      include: messageInclude,
    }),
  );
}

export async function send(userId: string, id: string, text: string) {
  const g = await loadForMember(userId, id);
  if (isArchived(g)) throw AppError.conflict("GAME_CHAT_ARCHIVED", "This chat is archived and read-only");
  const m = await prisma.gameMessage.create({ data: { requestId: id, senderId: userId, body: text }, include: messageInclude });
  return toMessage(m, userId, g.createdById);
}

// ───────────────────────── attendance ─────────────────────────

export async function markAttendance(userId: string, id: string, input: z.infer<typeof attendanceBody>, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.kind !== "MATCH") throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
    if (r.createdById !== userId) throw AppError.forbidden("REQUEST_NOT_OWNER", "Only the organiser can mark attendance");
    if (r.status === "CANCELLED") throw AppError.conflict("REQUEST_NOT_OPEN", "This game was cancelled");
    if (r.matchAt.getTime() > now.getTime()) throw AppError.conflict("REQUEST_NOT_STARTED", "The game hasn't started yet");
    if (now.getTime() > r.matchAt.getTime() + ATTENDANCE_WINDOW_DAYS * DAY) throw AppError.conflict("ATTENDANCE_WINDOW_CLOSED", `Attendance can be marked for ${ATTENDANCE_WINDOW_DAYS} days after the game`);

    const apps = await tx.application.findMany({ where: { requestId: id, id: { in: input.marks.map((m) => m.applicationId) } }, select: { id: true, status: true } });
    const byId = new Map(apps.map((a) => [a.id, a]));
    for (const m of input.marks) {
      const a = byId.get(m.applicationId);
      if (!a) throw AppError.invalid("marks", "Unknown player for this game");
      if (a.status !== "ACCEPTED") throw AppError.invalid("marks", "Only accepted players can be marked");
    }
    for (const m of input.marks) {
      await tx.application.update({ where: { id: m.applicationId }, data: { attendance: m.status, attendanceMarkedAt: now } });
    }
    const roster = await tx.application.findMany({ where: { requestId: id, status: "ACCEPTED" }, select: { id: true, playerId: true, attendance: true }, orderBy: { createdAt: "asc" } });
    return { items: roster.map((a) => ({ applicationId: a.id, playerId: a.playerId, attendance: a.attendance })) };
  });
}
