import { publicRating } from "../ratings/ratings.config.js";
import { imageUrl } from "../players/players.presenter.js";
import type { Prisma } from "@prisma/client";
import { locationInclude } from "../locations/location.service.js";

export const requestInclude = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  district: { select: { id: true, nameBn: true, nameEn: true, lat: true, lng: true } },
  upazila: { select: { id: true, nameBn: true, nameEn: true, lat: true, lng: true } },
  union: locationInclude.union,
  team: { select: { id: true, name: true, logoUrl: true } },
  series: { select: { id: true, title: true } },
  result: { select: { ourScore: true, theirScore: true, opponentName: true, summary: true, updatedAt: true, opponentConfirmedAt: true, opponentTeam: { select: { id: true, name: true, captainId: true } } } },
  createdBy: { select: { name: true, avatarUrl: true, captainAvgRating: true, captainRatingCount: true, recruiterProfile: { select: { id: true, verifiedBadge: true, logoUrl: true, logoPublicId: true } } } },
} satisfies Prisma.PlayerRequestInclude;

export type RequestRow = Prisma.PlayerRequestGetPayload<{ include: typeof requestInclude }>;

/** Upazila centre when known, else the district's. */
function centre(r: { upazila: { lat: number | null; lng: number | null }; district: { lat: number | null; lng: number | null } }) {
  const c = r.upazila.lat != null && r.upazila.lng != null ? r.upazila : r.district;
  return c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;
}

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
    location: { district: { id: r.district.id, nameBn: r.district.nameBn, nameEn: r.district.nameEn }, upazila: { id: r.upazila.id, nameBn: r.upazila.nameBn, nameEn: r.upazila.nameEn }, union: r.union },
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
            mode: r.feeMode,
            total: r.feeMode === "PER_PLAYER" ? r.groundFee * r.playersNeeded : r.groundFee,
            share: r.feeMode === "PER_PLAYER" ? r.groundFee : Math.ceil(r.groundFee / Math.max(1, r.playersNeeded)),
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
    isTurf: r.isTurf,
    pin: r.venueLat != null && r.venueLng != null ? { lat: r.venueLat, lng: r.venueLng } : null,
    areaCentre: centre(r),
    waitlistCount: ctx.waitlistCounts?.get(r.id) ?? 0,
    isOwner,
    myApplication: isOwner
      ? null
      : (() => {
          const m = ctx.myApplications?.get(r.id);
          return m ? { id: m.id, status: m.status, ...(m.waitlistPosition !== undefined && { waitlistPosition: m.waitlistPosition }) } : null;
        })(),
    ...(isOwner && ctx.pendingCounts && { pendingApplicants: ctx.pendingCounts.get(r.id) ?? 0 }),
    createdAt: r.createdAt.toISOString(),
  };
}
