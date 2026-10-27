import type { Prisma } from "@prisma/client";
import { locationInclude } from "../locations/location.service.js";

export const profileInclude = {
  user: { select: { name: true, avatarUrl: true } },
  ...locationInclude,
  sports: {
    orderBy: { createdAt: "asc" },
    include: { sport: { select: { id: true, code: true } } },
  },
  media: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.PlayerProfileInclude;

export type FullProfile = Prisma.PlayerProfileGetPayload<{ include: typeof profileInclude }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

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
    ...(detailed && { preferredFoot: s.preferredFoot, battingStyle: s.battingStyle, availability: s.availability }),
  };
}

/** The compact shape used in search results. */
export function toPlayerCard(p: FullProfile) {
  return {
    id: p.id,
    name: p.user.name,
    avatarUrl: p.user.avatarUrl,
    verifiedBadge: p.verifiedBadge,
    rating: { average: round2(p.avgRating), count: p.ratingCount },
    noShowCount: p.noShowCount,
    lastActiveAt: p.lastActiveAt.toISOString(),
    location: { district: p.district, upazila: p.upazila, union: p.union },
    sports: p.sports.map((s) => sportEntry(s, false)),
  };
}

/** What other users see. Deliberately omits email, phone, birth year and the user id. */
export function toPublicProfile(p: FullProfile) {
  return {
    ...toPlayerCard(p),
    sports: p.sports.map((s) => sportEntry(s, true)),
    bio: p.bio,
    media: p.media.map((m) => ({ id: m.id, type: m.type, url: m.url, order: m.order })),
    memberSince: p.createdAt.toISOString(),
  };
}

export function toMyProfile(p: FullProfile) {
  return { ...toPublicProfile(p), isVisible: p.isVisible, hiddenByAdmin: p.hiddenByAdminAt !== null };
}
