import { prisma } from "../../lib/prisma.js";
import { availableAmong } from "./availability.service.js";

/**
 * How dependable a player is, from what organisers recorded after games.
 * `attendanceRate` is null until at least one game has been marked (no data is not 0%).
 */
export interface Reliability {
  gamesPlayed: number;
  noShows: number;
  attendanceRate: number | null;
  ratingAverage: number;
  ratingCount: number;
}

export interface CardExtras {
  available: Set<string>;
  /** by User.id */
  reliability: Map<string, Reliability>;
}

export const noExtras: CardExtras = { available: new Set(), reliability: new Map() };

export const emptyReliability = (ratingAverage = 0, ratingCount = 0): Reliability => ({ gamesPlayed: 0, noShows: 0, attendanceRate: null, ratingAverage, ratingCount });

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One grouped query for a whole page of players. */
export async function reliabilityAmong(profiles: { userId: string; avgRating: number; ratingCount: number }[]): Promise<Map<string, Reliability>> {
  const out = new Map<string, Reliability>();
  if (profiles.length === 0) return out;
  const groups = await prisma.application.groupBy({
    by: ["playerId", "attendance"],
    where: { playerId: { in: profiles.map((p) => p.userId) }, attendance: { not: null } },
    _count: { _all: true },
  });
  const tally = new Map<string, { played: number; noShow: number }>();
  for (const g of groups) {
    const t = tally.get(g.playerId) ?? { played: 0, noShow: 0 };
    if (g.attendance === "ATTENDED") t.played += g._count._all;
    else t.noShow += g._count._all;
    tally.set(g.playerId, t);
  }
  for (const p of profiles) {
    const t = tally.get(p.userId) ?? { played: 0, noShow: 0 };
    const marked = t.played + t.noShow;
    out.set(p.userId, {
      gamesPlayed: t.played,
      noShows: t.noShow,
      attendanceRate: marked ? round3(t.played / marked) : null,
      ratingAverage: Math.round(p.avgRating * 100) / 100,
      ratingCount: p.ratingCount,
    });
  }
  return out;
}

/** Everything a player card needs beyond the profile row, fetched for a page at once. */
export async function cardExtras(profiles: { id: string; userId: string; avgRating: number; ratingCount: number }[]): Promise<CardExtras> {
  const [available, reliability] = await Promise.all([availableAmong(profiles.map((p) => p.id)), reliabilityAmong(profiles)]);
  return { available, reliability };
}
