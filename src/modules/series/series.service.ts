import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { locationInclude } from "../locations/location.service.js";
import { notify } from "../notifications/notifier.js";
import { createRequest } from "../requests/requests.service.js";
import { MAX_SERIES_PER_ORGANISER, type updateSeriesBody } from "./series.schema.js";

const OFFSET_MS = 6 * 60 * 60 * 1000; // Asia/Dhaka, no DST
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_MS = 3 * 60 * 60 * 1000; // a new game is never posted for less than 3 hours ahead

const include = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  ...locationInclude,
  createdBy: { select: { name: true, avatarUrl: true } },
  _count: { select: { members: true } },
} satisfies Prisma.GameSeriesInclude;
type Row = Prisma.GameSeriesGetPayload<{ include: typeof include }>;

/** The first instant after `after` that falls on `weekday` at `hhmm` Dhaka time. */
export function nextOccurrence(after: Date, weekday: number, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const localDay = Math.floor((after.getTime() + OFFSET_MS) / DAY_MS);
  for (let d = 0; d <= 8; d++) {
    const day = localDay + d;
    if ((((day + 4) % 7) + 7) % 7 !== weekday) continue; // 1970-01-01 was a Thursday (4)
    const at = new Date(day * DAY_MS - OFFSET_MS + (h * 60 + m) * 60_000);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("unreachable: a weekday recurs within 8 days");
}

const gameOut = (g: { id: string; matchAt: Date; status: "OPEN" | "FILLED" | "CANCELLED" | "COMPLETED"; playersNeeded: number; playersAccepted: number }) => ({
  id: g.id,
  matchAt: g.matchAt.toISOString(),
  status: g.status,
  spotsLeft: Math.max(0, g.playersNeeded - g.playersAccepted),
});

async function present(userId: string, r: Row) {
  const [games, mine] = await Promise.all([
    prisma.playerRequest.findMany({
      where: { seriesId: r.id, isHidden: false },
      orderBy: { matchAt: "desc" },
      take: 6,
      select: { id: true, matchAt: true, status: true, playersNeeded: true, playersAccepted: true },
    }),
    prisma.seriesMember.findUnique({ where: { seriesId_userId: { seriesId: r.id, userId } }, select: { id: true } }),
  ]);
  const now = Date.now();
  const upcoming = games.filter((g) => g.matchAt.getTime() > now && (g.status === "OPEN" || g.status === "FILLED")).sort((a, b) => a.matchAt.getTime() - b.matchAt.getTime())[0];
  const recent = games.filter((g) => g !== upcoming).slice(0, 5);
  return {
    id: r.id,
    title: r.title,
    sport: r.sport,
    location: { district: r.district, upazila: r.upazila, union: r.union },
    venueText: r.venueText,
    weekday: r.weekday,
    startTime: r.startTime,
    playersNeeded: r.playersNeeded,
    joinMode: r.joinMode,
    isPaid: r.isPaid,
    isActive: r.isActive,
    regularsCount: r._count.members,
    isOwner: r.createdById === userId,
    isRegular: !!mine,
    organiser: { name: r.createdBy.name, avatarUrl: r.createdBy.avatarUrl },
    nextGame: upcoming ? gameOut(upcoming) : null,
    recentGames: recent.map(gameOut),
  };
}

const load = async (id: string) => {
  const r = await prisma.gameSeries.findUnique({ where: { id }, include });
  if (!r) throw AppError.notFound("SERIES_NOT_FOUND", "Weekly game not found");
  return r;
};

/** Makes a match weekly. The source game becomes the first game of the series. */
export async function fromRequest(userId: string, requestId: string, title: string) {
  const game = await prisma.playerRequest.findUnique({ where: { id: requestId } });
  if (!game) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  if (game.createdById !== userId) throw AppError.forbidden("REQUEST_NOT_OWNER", "Only the person who posted this match can make it weekly");
  if (game.kind !== "MATCH") throw AppError.conflict("SERIES_MATCH_ONLY", "Only matches can repeat weekly, not events");
  if (game.seriesId) throw AppError.conflict("SERIES_EXISTS", "This game is already part of a weekly series");
  if (title.trim().length < 2) throw AppError.invalid("title", "Give the weekly game a name");
  const mine = await prisma.gameSeries.count({ where: { createdById: userId, isActive: true } });
  if (mine >= MAX_SERIES_PER_ORGANISER) throw AppError.conflict("SERIES_LIMIT", `You can run at most ${MAX_SERIES_PER_ORGANISER} weekly games`);

  const local = new Date(game.matchAt.getTime() + OFFSET_MS);
  const startTime = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const series = await prisma.$transaction(async (tx) => {
    const s = await tx.gameSeries.create({
      data: {
        createdById: userId,
        title: title.trim(),
        sportId: game.sportId,
        districtId: game.districtId,
        upazilaId: game.upazilaId,
        unionId: game.unionId,
        venueText: game.venueText,
        weekday: local.getUTCDay(),
        startTime,
        positionsNeeded: game.positionsNeeded,
        playersNeeded: game.playersNeeded,
        isPaid: game.isPaid,
        budgetMin: game.budgetMin,
        budgetMax: game.budgetMax,
        notes: game.notes,
        joinMode: game.joinMode,
        teamId: game.teamId,
      },
      include,
    });
    await tx.playerRequest.update({ where: { id: requestId }, data: { seriesId: s.id } });
    return s;
  });
  return present(userId, series);
}

export async function get(userId: string, id: string) {
  return present(userId, await load(id));
}

export async function mine(userId: string) {
  const rows = await prisma.gameSeries.findMany({
    where: { OR: [{ createdById: userId }, { members: { some: { userId } } }] },
    include,
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 30,
  });
  return Promise.all(rows.map((r) => present(userId, r)));
}

export async function update(userId: string, id: string, patch: z.infer<typeof updateSeriesBody>) {
  const r = await load(id);
  if (r.createdById !== userId) throw AppError.forbidden("SERIES_NOT_OWNER", "Only the organiser can change this weekly game");
  if (patch.isActive === true && !r.isActive) {
    const active = await prisma.gameSeries.count({ where: { createdById: userId, isActive: true } });
    if (active >= MAX_SERIES_PER_ORGANISER) throw AppError.conflict("SERIES_LIMIT", `You can run at most ${MAX_SERIES_PER_ORGANISER} weekly games`);
  }
  const updated = await prisma.gameSeries.update({ where: { id }, data: patch, include });
  return present(userId, updated);
}

export async function becomeRegular(userId: string, id: string) {
  const r = await load(id);
  if (r.createdById === userId) throw AppError.conflict("SERIES_OWN", "You run this weekly game");
  if (!r.isActive) throw AppError.conflict("SERIES_PAUSED", "This weekly game is paused");
  const profile = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw AppError.forbidden("PLAYER_PROFILE_REQUIRED", "Create your player profile first");
  await prisma.seriesMember.upsert({ where: { seriesId_userId: { seriesId: id, userId } }, create: { seriesId: id, userId }, update: {} });
  return present(userId, await load(id));
}

export async function leaveRegulars(userId: string, id: string) {
  await load(id);
  await prisma.seriesMember.deleteMany({ where: { seriesId: id, userId } });
  return present(userId, await load(id));
}

/**
 * Posts the next game of every active series that has none coming up, for the first matching time after the latest
 * game (and at least 3 hours from now). A cancelled game is not re-posted: the series simply resumes the next week.
 * Regulars are told. Safe to run on several instances: a second run finds the game already there.
 */
export async function postDueSeriesGames(now = new Date()): Promise<number> {
  const due = await prisma.gameSeries.findMany({
    where: {
      isActive: true,
      createdBy: { status: "ACTIVE" },
      games: { none: { status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: now } } },
    },
    include: { members: { select: { userId: true } }, sport: { select: { nameBn: true, nameEn: true } } },
    take: 200,
  });
  let posted = 0;
  for (const s of due) {
    try {
      const last = await prisma.playerRequest.findFirst({ where: { seriesId: s.id }, orderBy: { matchAt: "desc" }, select: { matchAt: true } });
      const after = new Date(Math.max(now.getTime() + LEAD_MS, last?.matchAt.getTime() ?? 0));
      const matchAt = nextOccurrence(after, s.weekday, s.startTime);
      // a second instance may have just posted it
      if (await prisma.playerRequest.count({ where: { seriesId: s.id, matchAt } })) continue;
      const game = await createRequest(
        s.createdById,
        {
          sportId: s.sportId,
          matchAt: matchAt.toISOString(),
          venueText: s.venueText,
          districtId: s.districtId,
          upazilaId: s.upazilaId,
          unionId: s.unionId,
          positionsNeeded: s.positionsNeeded,
          playersNeeded: s.playersNeeded,
          isPaid: s.isPaid,
          budgetMin: s.budgetMin,
          budgetMax: s.budgetMax,
          notes: s.notes,
          joinMode: s.joinMode,
          teamId: s.teamId,
          kind: "MATCH",
        } as Parameters<typeof createRequest>[1],
        { seriesId: s.id },
      );
      posted++;
      const regulars = s.members.map((m) => m.userId).filter((u) => u !== s.createdById);
      if (regulars.length)
        notify({
          userIds: regulars,
          type: "SERIES_GAME_POSTED",
          data: { requestId: game.id, seriesId: s.id },
          params: { sport: { bn: s.sport.nameBn, en: s.sport.nameEn }, venue: s.venueText, when: matchAt, heading: s.title },
        });
    } catch (err) {
      // e.g. the organiser is at the active-games limit: leave it for the next run
      logger.warn({ err, seriesId: s.id }, "series game not posted");
    }
  }
  return posted;
}
