import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { haveAcceptedRelation } from "../contact/relation.js";
import { notify } from "../notifications/notifier.js";
import { MAX_NEW_CONVERSATIONS_PER_DAY, type conversationsQuery, type messagesQuery, type openBody } from "./chat.schema.js";

const DAY_MS = 86_400_000;
const unavailable = () => AppError.forbidden("CHAT_UNAVAILABLE", "You can't message this person");

const personSelect = {
  id: true, name: true, avatarUrl: true, role: true, status: true,
  playerProfile: { select: { id: true } },
  recruiterProfile: { select: { id: true, organization: true, verifiedBadge: true } },
} satisfies Prisma.UserSelect;
const include = { recruiter: { select: personSelect }, player: { select: personSelect } } satisfies Prisma.ConversationInclude;
type Row = Prisma.ConversationGetPayload<{ include: typeof include }>;

function present(c: Row, viewerId: string) {
  const mine = c.recruiterId === viewerId ? "recruiter" : "player";
  const other = mine === "recruiter" ? c.player : c.recruiter;
  return {
    id: c.id,
    other: {
      name: other.name,
      avatarUrl: other.avatarUrl,
      role: other.role as "PLAYER" | "RECRUITER",
      profileId: other.playerProfile?.id ?? null,
      recruiterId: other.recruiterProfile?.id ?? null,
      organization: other.recruiterProfile?.organization ?? null,
      verified: other.recruiterProfile?.verifiedBadge ?? false,
    },
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    unread: mine === "recruiter" ? c.recruiterUnread : c.playerUnread,
    blockedByMe: mine === "player" && c.blockedAt !== null,
  };
}

/** A conversation the caller takes part in, or 404 — other people's conversations don't exist for them. */
async function loadMine(userId: string, id: string) {
  const c = await prisma.conversation.findFirst({ where: { id, OR: [{ recruiterId: userId }, { playerId: userId }] }, include });
  if (!c) throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
  return c;
}

/**
 * Who may start a conversation: a recruiter with a player who shows their number on tap (the same choice that
 * governs the phone number) or who has accepted them; a player only with a recruiter they've accepted each other with.
 */
export async function open(userId: string, role: "PLAYER" | "RECRUITER", input: z.infer<typeof openBody>) {
  let recruiterId: string;
  let playerId: string;
  let needsRelation: boolean;

  if (role === "RECRUITER") {
    if (!input.profileId) throw AppError.invalid("profileId", "Say which player");
    const p = await prisma.playerProfile.findFirst({
      where: { id: input.profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" } },
      select: { userId: true, contactVisibility: true },
    });
    if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player not found");
    recruiterId = userId;
    playerId = p.userId;
    needsRelation = p.contactVisibility === "AFTER_ACCEPT";
  } else {
    if (!input.recruiterId) throw AppError.invalid("recruiterId", "Say which recruiter");
    const r = await prisma.recruiterProfile.findFirst({ where: { id: input.recruiterId, user: { status: "ACTIVE", role: "RECRUITER" } }, select: { userId: true } });
    if (!r) throw AppError.notFound("RECRUITER_PROFILE_NOT_FOUND", "Recruiter not found");
    recruiterId = r.userId;
    playerId = userId;
    needsRelation = true;
  }

  const existing = await prisma.conversation.findUnique({ where: { recruiterId_playerId: { recruiterId, playerId } }, include });
  if (existing) {
    if (existing.blockedAt && role === "RECRUITER") throw unavailable();
    return present(existing, userId);
  }

  if (needsRelation && !(await haveAcceptedRelation(recruiterId, playerId))) throw unavailable();
  if (role === "RECRUITER") {
    const today = await prisma.conversation.count({ where: { recruiterId, createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
    if (today >= MAX_NEW_CONVERSATIONS_PER_DAY) throw new AppError("CHAT_LIMIT", 429, `You can start up to ${MAX_NEW_CONVERSATIONS_PER_DAY} new conversations a day`);
  }
  const created = await prisma.conversation.upsert({ where: { recruiterId_playerId: { recruiterId, playerId } }, update: {}, create: { recruiterId, playerId }, include });
  return present(created, userId);
}

export async function list(userId: string, q: z.infer<typeof conversationsQuery>) {
  const rows = await prisma.conversation.findMany({
    where: {
      // People who've been suspended or deleted drop out; a player's blocked conversations stay visible to them.
      OR: [{ recruiterId: userId, player: { status: "ACTIVE" }, blockedAt: null }, { playerId: userId, recruiter: { status: "ACTIVE" } }],
    },
    include,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map((c) => present(c, userId)), nextCursor };
}

const toMessage = (m: { id: string; senderId: string; body: string; createdAt: Date }, viewerId: string) => ({ id: m.id, mine: m.senderId === viewerId, body: m.body, createdAt: m.createdAt.toISOString() });

export async function messages(userId: string, id: string, q: z.infer<typeof messagesQuery>) {
  await loadMine(userId, id);
  if (q.after) {
    const anchor = await prisma.message.findFirst({ where: { id: q.after, conversationId: id }, select: { createdAt: true, id: true } });
    if (!anchor) throw AppError.invalid("after", "Unknown message");
    const rows = await prisma.message.findMany({
      where: { conversationId: id, OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: q.limit,
    });
    return rows.map((m) => toMessage(m, userId));
  }
  const rows = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.before, q.limit),
  });
  return toPage(rows, q.limit).items.map((m) => toMessage(m, userId));
}

export async function send(userId: string, id: string, text: string) {
  const c = await loadMine(userId, id);
  const asRecruiter = c.recruiterId === userId;
  const other = asRecruiter ? c.player : c.recruiter;
  if (other.status !== "ACTIVE") throw unavailable();
  if (asRecruiter && c.blockedAt) throw unavailable(); // a blocked recruiter isn't told why

  const { message, recipientUnread } = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({ data: { conversationId: id, senderId: userId, body: text } });
    const updated = await tx.conversation.update({
      where: { id },
      data: { lastMessageAt: message.createdAt, lastMessagePreview: text.slice(0, 80), ...(asRecruiter ? { playerUnread: { increment: 1 } } : { recruiterUnread: { increment: 1 } }) },
      select: { playerUnread: true, recruiterUnread: true },
    });
    return { message, recipientUnread: asRecruiter ? updated.playerUnread : updated.recruiterUnread };
  });

  // One push when the thread goes from "all read" to "has unread", not one per message.
  if (recipientUnread === 1) {
    const me = asRecruiter ? c.recruiter : c.player;
    notify({ userIds: [other.id], type: "NEW_MESSAGE", data: { conversationId: id }, params: { actor: me.recruiterProfile?.organization ?? me.name, text: text.slice(0, 120) } });
  }
  return toMessage(message, userId);
}

export async function markRead(userId: string, id: string) {
  const c = await loadMine(userId, id);
  await prisma.conversation.update({ where: { id }, data: c.recruiterId === userId ? { recruiterUnread: 0 } : { playerUnread: 0 } });
  return { unread: 0 };
}

export async function setBlocked(userId: string, id: string, blocked: boolean) {
  const c = await loadMine(userId, id);
  if (c.playerId !== userId) throw AppError.forbidden();
  return present(await prisma.conversation.update({ where: { id: c.id }, data: { blockedAt: blocked ? new Date() : null }, include }), userId);
}

// ── moderation: only reachable by an admin handling a report, and always audit-logged ──

export async function transcriptForAdmin(adminId: string, id: string) {
  const c = await prisma.conversation.findUnique({ where: { id }, include });
  if (!c) throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
  const rows = await prisma.message.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 });
  await prisma.adminAction.create({ data: { adminId, action: "CONVERSATION_VIEW", targetType: "CONVERSATION", targetId: id } });
  return {
    id,
    recruiter: { id: c.recruiterId, name: c.recruiter.name },
    player: { id: c.playerId, name: c.player.name },
    messages: rows.map((m) => ({ id: m.id, from: m.senderId === c.recruiterId ? "RECRUITER" : "PLAYER", body: m.body, createdAt: m.createdAt.toISOString() })),
  };
}
