import { Prisma, type Rating } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { requestInclude, toRequest } from "../requests/requests.presenter.js";
import type { createRatingBody } from "./ratings.schema.js";
import { RATING_WINDOW_DAYS } from "./ratings.schema.js";

const WINDOW_MS = RATING_WINDOW_DAYS * 86_400_000;
type Scores = Record<string, number>;
type Body = z.infer<typeof createRatingBody>;

export const windowEnd = (completedAt: Date) => new Date(completedAt.getTime() + WINDOW_MS);

export function toRating(r: Rating) {
  return {
    id: r.id,
    direction: r.direction,
    scores: r.scores as Scores,
    overall: Math.round(r.overall * 100) / 100,
    comment: r.comment,
    noShow: r.noShow,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Checks which score keys the caller must/must not send, and returns the final scores + mean.
 * A no-show carries no scores; its stored `overall` is a placeholder (1) that every aggregate ignores.
 */
function buildScores(direction: Rating["direction"], isPaid: boolean, body: Body): { scores: Scores; overall: number; noShow: boolean } {
  const given = Object.fromEntries(Object.entries(body.scores ?? {}).filter(([, v]) => v !== undefined)) as Scores;
  const keys = Object.keys(given);
  const noShow = body.noShow === true;

  if (direction === "PLAYER_TO_CAPTAIN" && noShow) throw AppError.invalid("noShow", "Only the captain can report a no-show");

  if (noShow) {
    if (keys.length) throw AppError.invalid("scores", "A no-show has no scores");
    return { scores: {}, overall: 1, noShow: true };
  }

  const required = direction === "CAPTAIN_TO_PLAYER" ? ["skill", "punctuality", "behavior"] : isPaid ? ["payment", "behavior", "organization"] : ["behavior", "organization"];
  const missing = required.filter((k) => given[k] === undefined);
  if (missing.length) throw AppError.invalid("scores", `Missing score(s): ${missing.join(", ")}`);
  const extra = keys.filter((k) => !required.includes(k));
  if (extra.length) throw AppError.invalid("scores", `Not applicable here: ${extra.join(", ")}`);

  const overall = required.reduce((sum, k) => sum + given[k]!, 0) / required.length;
  return { scores: given, overall, noShow: false };
}

export async function createRating(userId: string, requestId: string, body: Body) {
  const request = await prisma.playerRequest.findUnique({
    where: { id: requestId },
    select: { id: true, createdById: true, status: true, completedAt: true, isPaid: true },
  });
  if (!request) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");

  // Who is the caller in this match, and who are they rating?
  const isCaptain = request.createdById === userId;
  let rateeId: string;
  if (isCaptain) {
    if (!body.applicationId) throw AppError.invalid("applicationId", "Say which accepted player you're rating");
    const app = await prisma.application.findFirst({ where: { id: body.applicationId, requestId, status: "ACCEPTED" }, select: { playerId: true } });
    if (!app) throw AppError.notFound("RATING_TARGET_NOT_FOUND", "No accepted player with that applicationId on this match");
    rateeId = app.playerId;
  } else {
    if (body.applicationId) throw AppError.invalid("applicationId", "Only the captain sends applicationId");
    const mine = await prisma.application.findFirst({ where: { requestId, playerId: userId, status: "ACCEPTED" }, select: { id: true } });
    if (!mine) throw AppError.forbidden("RATING_NOT_PARTICIPANT", "Only the poster and accepted players can rate this match");
    rateeId = request.createdById;
  }

  if (request.status !== "COMPLETED" || !request.completedAt) {
    throw AppError.conflict("REQUEST_NOT_COMPLETED", "You can rate once the poster marks the match completed");
  }
  if (Date.now() > windowEnd(request.completedAt).getTime()) {
    throw AppError.conflict("RATING_WINDOW_CLOSED", `Ratings close ${RATING_WINDOW_DAYS} days after the match is completed`);
  }

  const direction: Rating["direction"] = isCaptain ? "CAPTAIN_TO_PLAYER" : "PLAYER_TO_CAPTAIN";
  const { scores, overall, noShow } = buildScores(direction, request.isPaid, body);

  if (!isCaptain) {
    // A player the captain marked as a no-show can't answer back with a rating.
    const struck = await prisma.rating.findFirst({ where: { requestId, rateeId: userId, noShow: true }, select: { id: true } });
    if (struck) throw AppError.conflict("RATING_NOT_ELIGIBLE", "You were marked as a no-show for this match");
  }

  return prisma.$transaction(async (tx) => {
    // Serialize everything that changes this person's aggregates. Without the lock, two ratings landing
    // together would each recompute without seeing the other and the stored average would be wrong.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${rateeId} FOR UPDATE`;

    let rating: Rating;
    try {
      rating = await tx.rating.create({
        data: { requestId, raterId: userId, rateeId, direction, scores, overall, noShow, comment: body.comment ?? null },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw AppError.conflict("RATING_EXISTS", "You already rated this");
      }
      throw err;
    }
    await recomputeAggregates(tx, rateeId, direction);
    return toRating(rating);
  });
}

/**
 * Recomputes from the rating rows (not incrementally), so it can never drift.
 * No-shows are strikes, not reviews: they raise noShowCount and are excluded from the average and its count.
 */
async function recomputeAggregates(tx: Prisma.TransactionClient, rateeId: string, direction: Rating["direction"]) {
  const reviews = await tx.rating.aggregate({ where: { rateeId, direction, noShow: false }, _avg: { overall: true }, _count: { _all: true } });
  const avg = reviews._avg.overall ?? 0;
  const count = reviews._count._all;

  if (direction === "CAPTAIN_TO_PLAYER") {
    const noShowCount = await tx.rating.count({ where: { rateeId, direction, noShow: true } });
    await tx.playerProfile.updateMany({ where: { userId: rateeId }, data: { avgRating: avg, ratingCount: count, noShowCount } });
  } else {
    await tx.user.update({ where: { id: rateeId }, data: { captainAvgRating: avg, captainRatingCount: count } });
  }
}

// ───────────────────────── pending ─────────────────────────

export async function pendingRatings(userId: string) {
  const cutoff = new Date(Date.now() - WINDOW_MS);
  const base = { status: "COMPLETED" as const, completedAt: { gt: cutoff } };

  const [asCaptain, asPlayer] = await Promise.all([
    prisma.playerRequest.findMany({
      where: { ...base, createdById: userId },
      include: {
        ...requestInclude,
        applications: {
          where: { status: "ACCEPTED" },
          select: { id: true, playerId: true, player: { select: { name: true, avatarUrl: true } } },
        },
        ratings: { where: { raterId: userId }, select: { rateeId: true } },
      },
      orderBy: { completedAt: "desc" },
      take: 50,
    }),
    prisma.playerRequest.findMany({
      where: { ...base, applications: { some: { playerId: userId, status: "ACCEPTED" } } },
      include: { ...requestInclude, ratings: { where: { OR: [{ raterId: userId }, { rateeId: userId, noShow: true }] }, select: { raterId: true, noShow: true } } },
      orderBy: { completedAt: "desc" },
      take: 50,
    }),
  ]);

  const out: Array<{ completedAt: Date; item: object }> = [];

  for (const r of asCaptain) {
    const rated = new Set(r.ratings.map((x) => x.rateeId));
    const targets = r.applications
      .filter((a) => !rated.has(a.playerId))
      .map((a) => ({ applicationId: a.id, name: a.player.name, avatarUrl: a.player.avatarUrl }));
    if (targets.length) {
      out.push({ completedAt: r.completedAt!, item: { request: toRequest(r, { viewerId: userId }), role: "CAPTAIN", rateBy: windowEnd(r.completedAt!).toISOString(), targets } });
    }
  }
  for (const r of asPlayer) {
    const alreadyRated = r.ratings.some((x) => x.raterId === userId);
    const struck = r.ratings.some((x) => x.noShow && x.raterId !== userId);
    if (!alreadyRated && !struck) {
      out.push({
        completedAt: r.completedAt!,
        item: {
          request: toRequest(r, { viewerId: userId }),
          role: "PLAYER",
          rateBy: windowEnd(r.completedAt!).toISOString(),
          targets: [{ applicationId: null, name: r.createdBy.name, avatarUrl: r.createdBy.avatarUrl }],
        },
      });
    }
  }
  return out.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime()).map((x) => x.item);
}

// ───────────────────────── public reviews ─────────────────────────

export async function playerReviews(profileId: string, q: { cursor?: string; limit: number }) {
  const profile = await prisma.playerProfile.findFirst({
    where: { id: profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  if (!profile) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player not found");

  const rows = await prisma.rating.findMany({
    where: { rateeId: profile.userId, direction: "CAPTAIN_TO_PLAYER", noShow: false },
    include: {
      rater: { select: { name: true, avatarUrl: true } },
      request: { select: { matchAt: true, sport: { select: { id: true, code: true, nameBn: true, nameEn: true } } } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({
      id: r.id,
      overall: Math.round(r.overall * 100) / 100,
      scores: r.scores as Scores,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      rater: r.rater,
      request: { sport: r.request.sport, matchAt: r.request.matchAt.toISOString() },
    })),
    nextCursor,
  };
}
