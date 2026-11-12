import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { ATTENDANCE_WINDOW_DAYS } from "../games/games.schema.js";
import { reliabilityAmong } from "../players/reliability.service.js";
import { publicRating } from "../ratings/ratings.config.js";
import { pendingRatings } from "../ratings/ratings.service.js";

const DAY = 86_400_000;
export type DashboardRole = "PLAYER" | "RECRUITER";

const gameSelect = {
  id: true,
  title: true,
  venueText: true,
  matchAt: true,
  kind: true,
  playersNeeded: true,
  playersAccepted: true,
  sport: { select: { nameBn: true, nameEn: true } },
} as const;
type GameRow = { id: string; title: string | null; venueText: string; matchAt: Date; kind: "MATCH" | "EVENT"; sport: { nameBn: string; nameEn: string } };
const toGame = (g: GameRow) => ({ id: g.id, title: g.title, venueText: g.venueText, matchAt: g.matchAt.toISOString(), kind: g.kind, sport: g.sport });

const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

/**
 * Profile completeness: a checklist the person can act on, not a vanity score. Each item is worth the same, `missing`
 * names what is left, and the clients turn each name into a link to the screen that fixes it.
 */
export function completeness(done: Record<string, boolean>) {
  const keys = Object.keys(done);
  const missing = keys.filter((k) => !done[k]);
  return { percent: Math.round(((keys.length - missing.length) / keys.length) * 100), missing };
}

async function playerDashboard(userId: string) {
  const now = new Date();
  const profile = await prisma.playerProfile.findUnique({
    where: { userId },
    include: {
      user: { select: { avatarUrl: true, creditBalance: true } },
      media: { select: { type: true } },
      sports: { select: { availability: true, headline: true, statsVerifiedAt: true, _count: { select: { achievements: true } } } },
    },
  });
  const credits = profile?.user.creditBalance ?? (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } })).creditBalance;
  if (!profile) {
    return {
      role: "PLAYER" as const,
      profile: { exists: false, visible: false, hiddenByAdmin: false, verified: false, completeness: completeness({ profile: false }) },
      reliability: { gamesPlayed: 0, noShows: 0, attendanceRate: null },
      rating: publicRating(0, 0),
      reviewsToGive: 0,
      reviewsNewThisWeek: 0,
      upcoming: [],
      applications: { pending: 0 },
      invites: { pending: 0 },
      views: { last7Days: 0 },
      credits,
    };
  }

  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [reliability, upcoming, pendingApps, pendingInvites, views, toGive, newReviews] = await Promise.all([
    reliabilityAmong([{ userId, avgRating: profile.avgRating, ratingCount: profile.ratingCount }]),
    prisma.application.findMany({
      where: { playerId: userId, status: "ACCEPTED", request: { matchAt: { gt: now }, status: { in: ["OPEN", "FILLED"] } } },
      orderBy: { request: { matchAt: "asc" } },
      take: 5,
      select: { request: { select: gameSelect } },
    }),
    prisma.application.count({ where: { playerId: userId, status: "PENDING", request: { status: "OPEN", matchAt: { gt: now } } } }),
    prisma.invite.count({ where: { profileId: profile.id, status: "PENDING" } }),
    prisma.profileView.count({ where: { profileId: profile.id, createdAt: { gte: weekAgo } } }),
    pendingRatings(userId),
    prisma.rating.count({ where: { rateeId: userId, noShow: false, hiddenByAdminAt: null, revealedAt: { gte: weekAgo } } }),
  ]);
  const rel = reliability.get(userId);

  return {
    role: "PLAYER" as const,
    profile: {
      exists: true,
      visible: profile.isVisible,
      hiddenByAdmin: profile.hiddenByAdminAt !== null,
      verified: profile.verifiedBadge,
      completeness: completeness({
        photo: profile.user.avatarUrl !== null,
        cover: profile.coverPublicId !== null || profile.coverUrl !== null,
        bio: !!profile.bio?.trim(),
        gallery: profile.media.some((m) => m.type === "PHOTO"),
        video: profile.media.some((m) => m.type === "VIDEO_LINK"),
        availability: profile.sports.some((s) => s.availability !== null),
        achievement: profile.sports.some((s) => s._count.achievements > 0),
        verification: profile.verifiedBadge || profile.sports.some((s) => s.statsVerifiedAt !== null),
      }),
    },
    reliability: { gamesPlayed: rel?.gamesPlayed ?? 0, noShows: rel?.noShows ?? 0, attendanceRate: rel?.attendanceRate ?? null },
    rating: publicRating(profile.avgRating, profile.ratingCount),
    reviewsToGive: toGive.length,
    reviewsNewThisWeek: newReviews,
    upcoming: upcoming.map((a) => toGame(a.request)),
    applications: { pending: pendingApps },
    invites: { pending: pendingInvites },
    views: { last7Days: views },
    credits,
  };
}

async function recruiterDashboard(userId: string) {
  const now = new Date();
  const profile = await prisma.recruiterProfile.findUnique({
    where: { userId },
    select: { id: true, organization: true, bio: true, sportIds: true, verifiedBadge: true, logoUrl: true, user: { select: { avatarUrl: true, creditBalance: true, captainAvgRating: true, captainRatingCount: true } } },
  });
  const user = profile?.user ?? (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarUrl: true, creditBalance: true, captainAvgRating: true, captainRatingCount: true } }));

  const since90 = new Date(now.getTime() - 90 * DAY);
  const windowStart = new Date(now.getTime() - ATTENDANCE_WINDOW_DAYS * DAY);
  const [open, upcoming, pendingApplicants, unmarked, hosted, marks, toGive, shortlist, invitesPending, invitesAccepted, everHosted] = await Promise.all([
    prisma.playerRequest.count({ where: { createdById: userId, status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: now } } }),
    prisma.playerRequest.findMany({
      where: { createdById: userId, status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: now } },
      orderBy: { matchAt: "asc" },
      take: 5,
      select: { ...gameSelect, _count: { select: { applications: { where: { status: "PENDING" } } } } },
    }),
    prisma.application.count({ where: { status: "PENDING", request: { createdById: userId, status: "OPEN", matchAt: { gt: now } } } }),
    prisma.application.findMany({
      where: { status: "ACCEPTED", attendance: null, request: { createdById: userId, kind: "MATCH", status: { not: "CANCELLED" }, matchAt: { lt: now, gt: windowStart } } },
      select: { requestId: true },
    }),
    prisma.playerRequest.findMany({ where: { createdById: userId, status: { not: "CANCELLED" }, matchAt: { lt: now, gt: since90 } }, select: { playersNeeded: true, playersAccepted: true } }),
    prisma.application.groupBy({ by: ["attendance"], where: { attendance: { not: null }, request: { createdById: userId, matchAt: { gt: since90 } } }, _count: { _all: true } }),
    pendingRatings(userId),
    prisma.shortlistEntry.count({ where: { recruiterId: userId } }),
    prisma.invite.count({ where: { recruiterId: userId, status: "PENDING" } }),
    prisma.invite.count({ where: { recruiterId: userId, status: "ACCEPTED" } }),
    prisma.playerRequest.count({ where: { createdById: userId } }),
  ]);

  const unmarkedBy = new Map<string, number>();
  for (const u of unmarked) unmarkedBy.set(u.requestId, (unmarkedBy.get(u.requestId) ?? 0) + 1);
  const attendGames = unmarkedBy.size
    ? await prisma.playerRequest.findMany({ where: { id: { in: [...unmarkedBy.keys()] } }, orderBy: { matchAt: "desc" }, take: 5, select: gameSelect })
    : [];

  const attended = marks.find((m) => m.attendance === "ATTENDED")?._count._all ?? 0;
  const noShows = marks.find((m) => m.attendance === "NO_SHOW")?._count._all ?? 0;
  const needed = hosted.reduce((n, g) => n + g.playersNeeded, 0);
  const accepted = hosted.reduce((n, g) => n + Math.min(g.playersAccepted, g.playersNeeded), 0);

  return {
    role: "RECRUITER" as const,
    profile: {
      exists: profile !== null,
      id: profile?.id ?? null,
      verified: profile?.verifiedBadge ?? false,
      completeness: profile
        ? completeness({
            photo: profile.logoUrl !== null || user.avatarUrl !== null,
            organization: !!profile.organization?.trim(),
            bio: !!profile.bio?.trim(),
            sports: profile.sportIds.length > 0,
            firstGame: everHosted > 0,
            verification: profile.verifiedBadge,
          })
        : completeness({ profile: false }),
    },
    games: {
      open,
      upcoming: upcoming.map((g) => ({ ...toGame(g), playersNeeded: g.playersNeeded, playersAccepted: g.playersAccepted, pendingApplicants: g._count.applications })),
      needAttendance: attendGames.map((g) => ({ ...toGame(g), unmarked: unmarkedBy.get(g.id) ?? 0 })),
    },
    applicants: { pending: pendingApplicants },
    reviewsToGive: toGive.length,
    rating: publicRating(user.captainAvgRating, user.captainRatingCount),
    stats90: { gamesHosted: hosted.length, fillRate: ratio(accepted, needed), noShowRate: ratio(noShows, attended + noShows) },
    shortlist: { count: shortlist },
    invites: { pending: invitesPending, accepted: invitesAccepted },
    credits: user.creditBalance,
  };
}

/** The signed-in person's own numbers, for the role they are acting as. An admin has no dashboard here. */
export async function getDashboard(userId: string, tokenRole: string, asRole?: DashboardRole) {
  if (tokenRole !== "PLAYER" && tokenRole !== "RECRUITER") throw AppError.forbidden("DASHBOARD_NOT_AVAILABLE", "Admins use the admin dashboard");
  return (asRole ?? tokenRole) === "RECRUITER" ? recruiterDashboard(userId) : playerDashboard(userId);
}
