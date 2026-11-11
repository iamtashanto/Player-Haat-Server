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

export type AssetDims = { width: number | null; height: number | null };

export interface CardExtras {
  /** media path → pixel size, so a screen can reserve the space before the image loads (profile views only). */
  assets: Map<string, AssetDims>;
  available: Set<string>;
  /** by User.id */
  reliability: Map<string, Reliability>;
}

export const noExtras: CardExtras = { available: new Set(), reliability: new Map(), assets: new Map() };

export const emptyReliability = (ratingAverage = 0, ratingCount = 0): Reliability => ({ gamesPlayed: 0, noShows: 0, attendanceRate: null, ratingAverage, ratingCount });

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One grouped query for a whole page of players. */
export async function reliabilityAmong(profiles: { userId: string; avgRating: number; ratingCount: number }[]): Promise<Map<string, Reliability>> {
  const out = new Map<string, Reliability>();
  if (profiles.length === 0) return out;
  // Attendance is the single source of truth. A no-show under an open dispute, or one an admin removed, isn't counted.
  const ids = profiles.map((p) => p.userId);
  const rows = await prisma.$queryRaw<{ playerId: string; played: number; noShow: number }[]>`
    SELECT a."playerId",
           COUNT(*) FILTER (WHERE a.attendance = 'ATTENDED')::int AS played,
           COUNT(*) FILTER (WHERE a.attendance = 'NO_SHOW' AND NOT EXISTS (
             SELECT 1 FROM "Rating" r LEFT JOIN "RatingDispute" d ON d."ratingId" = r.id AND d.status = 'OPEN'
             WHERE r."requestId" = a."requestId" AND r."rateeId" = a."playerId" AND r."noShow"
               AND (r."hiddenByAdminAt" IS NOT NULL OR d.id IS NOT NULL)))::int AS "noShow"
    FROM "Application" a WHERE a."playerId" = ANY(${ids}) AND a.attendance IS NOT NULL GROUP BY a."playerId"`;
  const tally = new Map<string, { played: number; noShow: number }>(rows.map((r) => [r.playerId, { played: r.played, noShow: r.noShow }]));
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

export async function assetDims(paths: Array<string | null | undefined>): Promise<Map<string, AssetDims>> {
  const ids = [...new Set(paths.filter((p): p is string => !!p))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.mediaAsset.findMany({ where: { path: { in: ids } }, select: { path: true, width: true, height: true } });
  return new Map(rows.map((r) => [r.path, { width: r.width, height: r.height }]));
}

/** Everything a player card needs beyond the profile row, fetched for a page at once. `assets: true` adds image sizes (profile screens). */
export async function cardExtras(
  profiles: { id: string; userId: string; avgRating: number; ratingCount: number; coverPublicId?: string | null; media?: { publicId: string | null }[] }[],
  opts: { assets?: boolean } = {},
): Promise<CardExtras> {
  const [available, reliability, assets] = await Promise.all([
    availableAmong(profiles.map((p) => p.id)),
    reliabilityAmong(profiles),
    opts.assets ? assetDims(profiles.flatMap((p) => [p.coverPublicId, ...(p.media ?? []).map((m) => m.publicId)])) : Promise.resolve(new Map<string, AssetDims>()),
  ]);
  return { available, reliability, assets };
}
