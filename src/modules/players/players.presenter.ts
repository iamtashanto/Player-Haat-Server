import type { Prisma } from "@prisma/client";
import { locationInclude } from "../locations/location.service.js";

export const profileInclude = {
  user: { select: { name: true, avatarUrl: true } },
  ...locationInclude,
  sports: {
    orderBy: { createdAt: "asc" },
    include: {
      sport: { select: { id: true, code: true } },
      achievements: { orderBy: [{ year: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] },
    },
  },
  media: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.PlayerProfileInclude;

export type FullProfile = Prisma.PlayerProfileGetPayload<{ include: typeof profileInclude }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A sport profile other people may see: the player hasn't hidden it and no admin has. */
const isPublicSport = (s: FullProfile["sports"][number]) => s.isVisible && s.hiddenByAdminAt === null;

function sportEntry(s: FullProfile["sports"][number], detailed: boolean) {
  return {
    sportId: s.sportId,
    sportCode: s.sport.code,
    positions: s.positions,
    skillLevel: s.skillLevel,
    khepAvailable: s.khepAvailable,
    rateMin: s.rateMin,
    rateMax: s.rateMax,
    travelRadius: s.travelRadius,
    headline: s.headline,
    experienceYears: s.experienceYears,
    currentTeam: s.currentTeam,
    stats: s.stats as Record<string, number> | null,
    rating: { average: round2(s.avgRating), count: s.ratingCount },
    ...(detailed && {
      preferredFoot: s.preferredFoot,
      battingStyle: s.battingStyle,
      availability: s.availability,
      achievements: s.achievements.map((a) => ({ id: a.id, title: a.title, year: a.year, description: a.description })),
    }),
  };
}

/**
 * The compact shape used in search results. Only public sport profiles are listed; those that matched
 * the search's sport-level filters come first, so a recruiter lands on the most relevant one.
 */
export function toPlayerCard(p: FullProfile, matchedSportIds: number[] = []) {
  const matched = new Set(matchedSportIds);
  const sports = p.sports.filter(isPublicSport).sort((a, b) => Number(matched.has(b.sportId)) - Number(matched.has(a.sportId)));
  return {
    id: p.id,
    name: p.user.name,
    avatarUrl: p.user.avatarUrl,
    verifiedBadge: p.verifiedBadge,
    rating: { average: round2(p.avgRating), count: p.ratingCount },
    noShowCount: p.noShowCount,
    lastActiveAt: p.lastActiveAt.toISOString(),
    location: { district: p.district, upazila: p.upazila, union: p.union },
    sports: sports.map((s) => sportEntry(s, false)),
    matchedSportIds: sports.filter((s) => matched.has(s.sportId)).map((s) => s.sportId),
  };
}

/** What other users see. Deliberately omits email, phone, birth year and the user id. */
export function toPublicProfile(p: FullProfile) {
  return {
    ...toPlayerCard(p),
    sports: p.sports.filter(isPublicSport).map((s) => sportEntry(s, true)),
    bio: p.bio,
    media: p.media.map((m) => ({ id: m.id, type: m.type, url: m.url, order: m.order })),
    memberSince: p.createdAt.toISOString(),
  };
}

/** The owner sees every sport profile, including ones they (or an admin) have hidden, and why. */
export function toMyProfile(p: FullProfile) {
  return {
    ...toPublicProfile(p),
    sports: p.sports.map((s) => ({ ...sportEntry(s, true), isVisible: s.isVisible, hiddenByAdmin: s.hiddenByAdminAt !== null })),
    isVisible: p.isVisible,
    hiddenByAdmin: p.hiddenByAdminAt !== null,
  };
}
