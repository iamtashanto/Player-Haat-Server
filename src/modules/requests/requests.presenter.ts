import type { Prisma } from "@prisma/client";
import { locationInclude } from "../locations/location.service.js";

export const requestInclude = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  ...locationInclude,
  team: { select: { id: true, name: true, logoUrl: true } },
  createdBy: { select: { name: true, avatarUrl: true, captainAvgRating: true, captainRatingCount: true, recruiterProfile: { select: { id: true, verifiedBadge: true } } } },
} satisfies Prisma.PlayerRequestInclude;

export type RequestRow = Prisma.PlayerRequestGetPayload<{ include: typeof requestInclude }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ViewerContext {
  viewerId: string;
  /** requestId → the viewer's own application, when they have one. */
  myApplications?: Map<string, { id: string; status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" }>;
  /** requestId → pending applicant count (owner views). */
  pendingCounts?: Map<string, number>;
  /** requestId → how many are interested/applied, plus a few visible players (events). */
  interest?: Map<string, { count: number; preview: { profileId: string; name: string; avatarUrl: string | null }[] }>;
}

/** The creator's user id is deliberately not exposed — `isOwner` tells the app what it needs. */
export function toRequest(r: RequestRow, ctx: ViewerContext) {
  const isOwner = r.createdById === ctx.viewerId;
  return {
    id: r.id,
    status: r.status,
    sport: r.sport,
    matchAt: r.matchAt.toISOString(),
    venueText: r.venueText,
    location: { district: r.district, upazila: r.upazila, union: r.union },
    positionsNeeded: r.positionsNeeded,
    playersNeeded: r.playersNeeded,
    playersAccepted: r.playersAccepted,
    spotsLeft: Math.max(0, r.playersNeeded - r.playersAccepted),
    isPaid: r.isPaid,
    budgetMin: r.budgetMin,
    budgetMax: r.budgetMax,
    notes: r.notes,
    kind: r.kind,
    title: r.title,
    boostedUntil: r.boostedUntil && r.boostedUntil.getTime() > Date.now() ? r.boostedUntil.toISOString() : null,
    interested: ctx.interest?.get(r.id) ?? { count: 0, preview: [] },
    team: r.team,
    captain: {
      name: r.createdBy.name,
      avatarUrl: r.createdBy.avatarUrl,
      rating: { average: round2(r.createdBy.captainAvgRating), count: r.createdBy.captainRatingCount },
      // Set when the poster is a recruiter with a profile: the app links to their public card.
      recruiterId: r.createdBy.recruiterProfile?.id ?? null,
      recruiterVerified: r.createdBy.recruiterProfile?.verifiedBadge ?? false,
    },
    isOwner,
    myApplication: isOwner ? null : (ctx.myApplications?.get(r.id) ?? null),
    ...(isOwner && ctx.pendingCounts && { pendingApplicants: ctx.pendingCounts.get(r.id) ?? 0 }),
    createdAt: r.createdAt.toISOString(),
  };
}
