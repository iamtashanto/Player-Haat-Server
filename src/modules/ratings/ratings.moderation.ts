import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { isOwnedBy } from "../../lib/storage/paths.js";
import { notify } from "../notifications/notifier.js";
import { RATING_RULES } from "./ratings.config.js";
import { recomputeEverything } from "./ratings.service.js";

const DAY = 86_400_000;

/** The ratee answers a review once in public: up to 300 characters, editable for 24 hours after the first post. */
export async function setReply(userId: string, ratingId: string, text: string, now = new Date()) {
  const r = await prisma.rating.findUnique({ where: { id: ratingId } });
  if (!r || r.rateeId !== userId || r.revealedAt === null || r.hiddenByAdminAt !== null) throw AppError.notFound("RATING_NOT_FOUND", "Review not found");
  if (r.noShow) throw AppError.conflict("RATING_NOT_REPLYABLE", "A no-show can be disputed, not replied to");
  const clean = text.trim();
  if (clean.length === 0 || clean.length > RATING_RULES.replyMaxChars) throw AppError.invalid("text", `Reply must be 1–${RATING_RULES.replyMaxChars} characters`);
  if (r.replyText && r.repliedAt && now.getTime() > r.repliedAt.getTime() + RATING_RULES.replyEditHours * 3_600_000) {
    throw AppError.conflict("RATING_REPLY_LOCKED", `A reply can be edited for ${RATING_RULES.replyEditHours} hours`);
  }
  await prisma.rating.update({ where: { id: ratingId }, data: { replyText: clean, repliedAt: r.repliedAt ?? now } });
  return { text: clean, at: (r.repliedAt ?? now).toISOString() };
}

/** The ratee disputes a review or a no-show within 7 days of it being revealed. One dispute per rating. */
export async function openDispute(userId: string, ratingId: string, input: { reason: string; photoPublicId?: string | null }, now = new Date()) {
  const r = await prisma.rating.findUnique({ where: { id: ratingId }, include: { disputes: true } });
  if (!r || r.rateeId !== userId || r.revealedAt === null) throw AppError.notFound("RATING_NOT_FOUND", "Review not found");
  if (r.hiddenByAdminAt !== null) throw AppError.conflict("RATING_ALREADY_REMOVED", "This was already removed");
  if (now.getTime() > r.revealedAt.getTime() + RATING_RULES.disputeWindowDays * DAY) throw AppError.conflict("DISPUTE_WINDOW_CLOSED", `Disputes are open for ${RATING_RULES.disputeWindowDays} days after a review is revealed`);
  if (r.disputes.length > 0) throw AppError.conflict("DISPUTE_EXISTS", "You already disputed this");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) throw AppError.invalid("reason", "Explain in 10–1000 characters");
  if (input.photoPublicId && !isOwnedBy(userId, input.photoPublicId)) throw AppError.forbidden("MEDIA_NOT_OWNED", "That image is not yours");

  const dispute = await prisma.$transaction(async (tx) => {
    const d = await tx.ratingDispute.create({ data: { ratingId, disputerId: userId, reason, photoPublicId: input.photoPublicId ?? null } });
    await recomputeEverything(tx, userId); // an open dispute takes the strike out of the count while it is reviewed
    return d;
  });
  notify({ userIds: [r.raterId], type: "SYSTEM", data: { code: "DISPUTE_OPENED" }, params: { code: "DISPUTE_OPENED" } });
  return { id: dispute.id, status: dispute.status };
}

// ───────────────────────── admin ─────────────────────────

const audit = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], adminId: string, action: "RATING_HIDE" | "RATING_UNHIDE" | "RATING_DISPUTE_UPHOLD" | "RATING_DISPUTE_REMOVE" | "RATING_REPLY_REMOVE", targetId: string, reason: string) =>
  tx.adminAction.create({ data: { adminId, action, targetType: "RATING", targetId, reason } });

export async function adminListDisputes(q: { status?: "OPEN" | "UPHELD" | "REMOVED"; cursor?: string; limit: number }) {
  const rows = await prisma.ratingDispute.findMany({
    where: q.status ? { status: q.status } : {},
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: { rating: { include: { rater: { select: { id: true, name: true } }, ratee: { select: { id: true, name: true } } } } },
  });
  const nextCursor = rows.length > q.limit ? rows[q.limit - 1]!.id : null;
  return {
    items: rows.slice(0, q.limit).map((d) => ({
      id: d.id,
      status: d.status,
      reason: d.reason,
      photoPublicId: d.photoPublicId,
      adminNote: d.adminNote,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
      rating: { id: d.rating.id, requestId: d.rating.requestId, noShow: d.rating.noShow, overall: d.rating.noShow ? null : d.rating.overall, comment: d.rating.comment, rater: d.rating.rater, ratee: d.rating.ratee },
    })),
    nextCursor,
  };
}

/** UPHOLD keeps the review/strike (dispute rejected); REMOVE hides it and recomputes. Both sides are told. */
export async function adminResolveDispute(adminId: string, disputeId: string, input: { decision: "UPHOLD" | "REMOVE"; note: string }) {
  const note = input.note.trim();
  if (note.length < 3) throw AppError.invalid("note", "A reason is required");
  const d = await prisma.ratingDispute.findUnique({ where: { id: disputeId }, include: { rating: true } });
  if (!d) throw AppError.notFound("DISPUTE_NOT_FOUND", "Dispute not found");
  if (d.status !== "OPEN") throw AppError.conflict("DISPUTE_RESOLVED", "Already resolved");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.ratingDispute.update({ where: { id: d.id }, data: { status: input.decision === "REMOVE" ? "REMOVED" : "UPHELD", adminNote: note, resolvedById: adminId, resolvedAt: now } });
    if (input.decision === "REMOVE") await tx.rating.update({ where: { id: d.ratingId }, data: { hiddenByAdminAt: now } });
    await audit(tx, adminId, input.decision === "REMOVE" ? "RATING_DISPUTE_REMOVE" : "RATING_DISPUTE_UPHOLD", d.ratingId, note);
    await recomputeEverything(tx, d.rating.rateeId);
    await recomputeEverything(tx, d.rating.raterId);
  });
  const code = input.decision === "REMOVE" ? "DISPUTE_REMOVED" : "DISPUTE_UPHELD";
  notify({ userIds: [d.rating.rateeId, d.rating.raterId], type: "SYSTEM", data: { code }, params: { code } });
  return { id: d.id, status: input.decision === "REMOVE" ? "REMOVED" : "UPHELD" };
}

/** Admin moderation of any rating: hide/unhide recomputes every aggregate of both people. */
export async function adminSetHidden(adminId: string, ratingId: string, hidden: boolean, reason: string) {
  const r = await prisma.rating.findUnique({ where: { id: ratingId } });
  if (!r) throw AppError.notFound("RATING_NOT_FOUND", "Rating not found");
  if (reason.trim().length < 3) throw AppError.invalid("reason", "A reason is required");
  await prisma.$transaction(async (tx) => {
    await tx.rating.update({ where: { id: ratingId }, data: { hiddenByAdminAt: hidden ? new Date() : null } });
    await audit(tx, adminId, hidden ? "RATING_HIDE" : "RATING_UNHIDE", ratingId, reason.trim());
    await recomputeEverything(tx, r.rateeId);
    await recomputeEverything(tx, r.raterId);
  });
  return { id: ratingId, hidden };
}

export async function adminRemoveReply(adminId: string, ratingId: string, reason: string) {
  const r = await prisma.rating.findUnique({ where: { id: ratingId }, select: { id: true } });
  if (!r) throw AppError.notFound("RATING_NOT_FOUND", "Rating not found");
  if (reason.trim().length < 3) throw AppError.invalid("reason", "A reason is required");
  await prisma.$transaction(async (tx) => {
    await tx.rating.update({ where: { id: ratingId }, data: { replyText: null, repliedAt: null } });
    await audit(tx, adminId, "RATING_REPLY_REMOVE", ratingId, reason.trim());
  });
  return { id: ratingId };
}

/** Everything a person gave and received, hidden and unrevealed included (admin only). */
export async function adminUserRatings(userId: string) {
  const rows = await prisma.rating.findMany({
    where: { OR: [{ rateeId: userId }, { raterId: userId }] },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { disputes: { select: { id: true, status: true } } },
  });
  return rows.map((r) => ({
    id: r.id, requestId: r.requestId, direction: r.direction, raterId: r.raterId, rateeId: r.rateeId, noShow: r.noShow,
    overall: r.noShow ? null : r.overall, comment: r.comment, reply: r.replyText,
    revealedAt: r.revealedAt?.toISOString() ?? null, hiddenByAdminAt: r.hiddenByAdminAt?.toISOString() ?? null,
    dispute: r.disputes[0] ?? null, createdAt: r.createdAt.toISOString(),
  }));
}

/** Organisers who mark most of their players as no-shows: more than half, across at least three games. */
export async function flaggedOrganisers() {
  return prisma.$queryRaw<{ organiserId: string; name: string; games: number; marked: number; noShows: number }[]>`
    SELECT q."createdById" AS "organiserId", u.name, COUNT(DISTINCT q.id)::int AS games,
           COUNT(*)::int AS marked, COUNT(*) FILTER (WHERE a.attendance = 'NO_SHOW')::int AS "noShows"
    FROM "Application" a JOIN "PlayerRequest" q ON q.id = a."requestId" JOIN "User" u ON u.id = q."createdById"
    WHERE a.attendance IS NOT NULL
    GROUP BY q."createdById", u.name
    HAVING COUNT(DISTINCT q.id) >= ${RATING_RULES.flagMinGames}
       AND COUNT(*) FILTER (WHERE a.attendance = 'NO_SHOW')::float / COUNT(*) > ${RATING_RULES.flagNoShowShare}
    ORDER BY 5 DESC`;
}
