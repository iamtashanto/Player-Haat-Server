import { publicRating } from "../ratings/ratings.config.js";
import { imageUrl } from "../players/players.presenter.js";
import type { Prisma } from "@prisma/client";
import { locationInclude } from "../locations/location.service.js";

export const requestInclude = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  ...locationInclude,
  team: { select: { id: true, name: true, logoUrl: true } },
  series: { select: { id: true, title: true } },
  result: { select: { ourScore: true, theirScore: true, opponentName: true, summary: true, updatedAt: true, opponentConfirmedAt: true, opponentTeam: { select: { id: true, name: true, captainId: true } } } },
  createdBy: { select: { name: true, avatarUrl: true, captainAvgRating: true, captainRatingCount: true, recruiterProfile: { select: { id: true, verifiedBadge: true, logoUrl: true, logoPublicId: true } } } },
} satisfies Prisma.PlayerRequestInclude;

export type RequestRow = Prisma.PlayerRequestGetPayload<{ include: typeof requestInclude }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ViewerContext {
  viewerId: string;
  /** requestId → the viewer's own application, when they have one. */
  myApplications?: Map<string, { id: string; feePaid?: boolean; status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | "WAITLISTED"; waitlistPosition?: number }>;
  /** requestId → people waiting for a spot. */
  waitlistCounts?: Map<string, number>;
  /** requestId → accepted players already ticked as paid (owner views). */
  paidCounts?: Map<string, number>;
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
    joinMode: r.joinMode,
    title: r.title,
    boostedUntil: r.boostedUntil && r.boostedUntil.getTime() > Date.now() ? r.boostedUntil.toISOString() : null,
    interested: ctx.interest?.get(r.id) ?? { count: 0, preview: [] },
    team: r.team,
    captain: {
      name: r.createdBy.name,
      avatarUrl: r.createdBy.avatarUrl,
      rating: publicRating(r.createdBy.captainAvgRating, r.createdBy.captainRatingCount),
      // Set when the poster is a recruiter with a profile: the app links to their public card.
      recruiterId: r.createdBy.recruiterProfile?.id ?? null,
      recruiterVerified: r.createdBy.recruiterProfile?.verifiedBadge ?? false,
      logoUrl: r.createdBy.recruiterProfile ? imageUrl(r.createdBy.recruiterProfile.logoPublicId, r.createdBy.recruiterProfile.logoUrl) : null,
    },
    fee: r.groundFee != null
      ? (() => {
          const mine = ctx.myApplications?.get(r.id);
          const sees = isOwner || mine?.status === "ACCEPTED";
          return {
            total: r.groundFee,
            share: Math.ceil(r.groundFee / Math.max(1, r.playersNeeded)),
            payTo: sees ? r.feePayTo : null,
            ...(isOwner && { paidCount: ctx.paidCounts?.get(r.id) ?? 0 }),
            ...(!isOwner && mine?.status === "ACCEPTED" && { iPaid: mine.feePaid ?? false }),
          };
        })()
      : null,
    result: r.result
      ? { ourScore: r.result.ourScore, theirScore: r.result.theirScore, opponentName: r.result.opponentName, summary: r.result.summary, outcome: (r.result.ourScore > r.result.theirScore ? "WIN" : r.result.ourScore < r.result.theirScore ? "LOSS" : "DRAW") as "WIN" | "DRAW" | "LOSS", recordedAt: r.result.updatedAt.toISOString(), opponentTeam: r.result.opponentTeam ? { id: r.result.opponentTeam.id, name: r.result.opponentTeam.name } : null, confirmed: !!r.result.opponentConfirmedAt, canConfirm: !!r.result.opponentTeam && !r.result.opponentConfirmedAt && r.result.opponentTeam.captainId === ctx.viewerId }
      : null,
    series: r.series ? { id: r.series.id, title: r.series.title } : null,
    waitlistCount: ctx.waitlistCounts?.get(r.id) ?? 0,
    isOwner,
    myApplication: isOwner ? null : (ctx.myApplications?.get(r.id) ?? null),
    ...(isOwner && ctx.pendingCounts && { pendingApplicants: ctx.pendingCounts.get(r.id) ?? 0 }),
    createdAt: r.createdAt.toISOString(),
  };
}
