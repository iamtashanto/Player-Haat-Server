import type { AdminActionType, Prisma, ReportStatus, UserRole } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { CONFIG_SCHEMAS, clearConfigCache, readAll, type ConfigKey } from "../app-config/app-config.service.js";
import { retireParticipation } from "../moderation/participation.js";
import { notify } from "../notifications/notifier.js";
import { revokeAllForUser } from "../auth/token.service.js";
import type {
  actionsQuery,
  applicationsAdminQuery,
  broadcastNotificationBody,
  createPositionBody,
  createSportBody,
  notificationFilterQuery,
  playersQuery,
  recruitersQuery,
  reportsQuery,
  requestsAdminQuery,
  sportProfilesQuery,
  updateLocationBody,
  updatePositionBody,
  updateSportBody,
  updateSportProfileBody,
  usersQuery,
} from "./admin.schema.js";

type Tx = Prisma.TransactionClient;

/** Written in the same transaction as the change it records, so the log can't disagree with reality. */
const audit = (
  tx: Tx,
  adminId: string,
  action: AdminActionType,
  targetType: string,
  targetId: string,
  reason?: string | null,
  metadata?: Prisma.InputJsonObject,
) =>
  tx.adminAction.create({
    data: { adminId, action, targetType, targetId, reason: reason ?? null, metadata },
  });

// ───────────────────────── users ─────────────────────────

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  role: true,
  avatarUrl: true,
  emailVerifiedAt: true,
  createdAt: true,
  playerProfile: { select: { id: true, verifiedBadge: true } },
  recruiterProfile: { select: { id: true, verifiedBadge: true } },
} satisfies Prisma.UserSelect;

const toUserSummary = (u: Prisma.UserGetPayload<{ select: typeof userSelect }>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  role: u.role,
  avatarUrl: u.avatarUrl,
  emailVerified: u.emailVerifiedAt !== null,
  isVerified: u.playerProfile?.verifiedBadge || u.recruiterProfile?.verifiedBadge || false,
  profileId: u.playerProfile?.id ?? null,
  recruiterId: u.recruiterProfile?.id ?? null,
  createdAt: u.createdAt.toISOString(),
});

export async function listUsers(q: z.infer<typeof usersQuery>) {
  const where: Prisma.UserWhereInput = {
    ...(q.status && { status: q.status }),
    ...(q.role && { role: q.role }),
    ...(q.q && {
      OR: [
        { name: { contains: q.q, mode: "insensitive" } },
        { email: { contains: q.q, mode: "insensitive" } },
        { phone: { contains: q.q } },
      ],
    }),
    ...(q.verified === true && {
      OR: [{ playerProfile: { verifiedBadge: true } }, { recruiterProfile: { verifiedBadge: true } }],
    }),
    ...(q.verified === false && {
      playerProfile: { verifiedBadge: false },
      recruiterProfile: { verifiedBadge: false },
    }),
    ...(q.districtId && {
      OR: [
        { playerProfile: { districtId: q.districtId } },
        { recruiterProfile: { districtId: q.districtId } },
      ],
    }),
    ...(q.divisionId && {
      OR: [
        { playerProfile: { district: { divisionId: q.divisionId } } },
        { recruiterProfile: { district: { divisionId: q.divisionId } } },
      ],
    }),
    ...(q.sportId && {
      playerProfile: { sports: { some: { sportId: q.sportId } } },
    }),
  };

  const rows = await prisma.user.findMany({
    where,
    select: userSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toUserSummary), nextCursor };
}

export async function getUser(id: string) {
  const u = await prisma.user.findUnique({
    where: { id },
    include: {
      authAccounts: { select: { provider: true, createdAt: true } },
      playerProfile: {
        include: {
          district: { select: { id: true, nameEn: true, nameBn: true } },
          upazila: { select: { id: true, nameEn: true, nameBn: true } },
          sports: {
            include: {
              sport: { select: { id: true, code: true, nameEn: true, nameBn: true } },
              achievements: true,
            },
            orderBy: { createdAt: "asc" },
          },
          media: { orderBy: { order: "asc" } },
        },
      },
      recruiterProfile: {
        include: { district: { select: { id: true, nameEn: true, nameBn: true } } },
      },
      requestsCreated: {
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { sport: { select: { nameEn: true, code: true } }, _count: { select: { applications: true } } },
      },
      applications: {
        take: 5,
        orderBy: { createdAt: "desc" },
        include: {
          request: { select: { id: true, matchAt: true, venueText: true, sport: { select: { nameEn: true } } } },
        },
      },
      _count: {
        select: {
          requestsCreated: true,
          applications: true,
          ratingsReceived: true,
          ratingsGiven: true,
          reportsFiled: true,
        },
      },
    },
  });
  if (!u) throw AppError.notFound("USER_NOT_FOUND", "User not found");

  const [reportsAgainst, reportsFiled, auditHistory] = await Promise.all([
    prisma.report.findMany({
      where: {
        OR: [
          { targetType: "USER" as const, targetId: id },
          ...(u.playerProfile ? [{ targetType: "PLAYER_PROFILE" as const, targetId: u.playerProfile.id }] : []),
        ],
      },
      take: 10,
      orderBy: { createdAt: "desc" },
      include: { reporter: { select: { id: true, name: true } } },
    }),
    prisma.report.findMany({
      where: { reporterId: id },
      take: 5,
      orderBy: { createdAt: "desc" },
    }),
    prisma.adminAction.findMany({
      where: {
        OR: [
          { targetType: "USER", targetId: id },
          ...(u.playerProfile ? [{ targetType: "PLAYER_PROFILE", targetId: u.playerProfile.id }] : []),
        ],
      },
      take: 15,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    ...toUserSummary(u),
    birthYear: u.birthYear,
    authAccounts: u.authAccounts,
    captainRating: { average: u.captainAvgRating, count: u.captainRatingCount },
    recruiter: u.recruiterProfile
      ? {
          id: u.recruiterProfile.id,
          type: u.recruiterProfile.type,
          organization: u.recruiterProfile.organization,
          verifiedBadge: u.recruiterProfile.verifiedBadge,
          district: u.recruiterProfile.district,
        }
      : null,
    playerProfile: u.playerProfile
      ? {
          id: u.playerProfile.id,
          location: `${u.playerProfile.upazila.nameEn}, ${u.playerProfile.district.nameEn}`,
          isVisible: u.playerProfile.isVisible,
          hiddenByAdmin: u.playerProfile.hiddenByAdminAt !== null,
          verifiedBadge: u.playerProfile.verifiedBadge,
          avgRating: u.playerProfile.avgRating,
          ratingCount: u.playerProfile.ratingCount,
          noShowCount: u.playerProfile.noShowCount,
          sports: u.playerProfile.sports.map((sp) => ({
            id: sp.id,
            sportId: sp.sportId,
            sportCode: sp.sport.code,
            sportName: sp.sport.nameEn,
            positions: sp.positions,
            headline: sp.headline,
            experienceYears: sp.experienceYears,
            khepAvailable: sp.khepAvailable,
            rates: { min: sp.rateMin, max: sp.rateMax },
            stats: sp.stats,
            avgRating: sp.avgRating,
            ratingCount: sp.ratingCount,
            hiddenByAdmin: sp.hiddenByAdminAt !== null,
            achievements: sp.achievements,
          })),
          media: u.playerProfile.media,
        }
      : null,
    recentRequests: u.requestsCreated.map((r) => ({
      id: r.id,
      sport: r.sport.nameEn,
      venue: r.venueText,
      matchAt: r.matchAt.toISOString(),
      status: r.status,
      applicationsCount: r._count.applications,
    })),
    recentApplications: u.applications.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      sport: a.request.sport.nameEn,
      venue: a.request.venueText,
      matchAt: a.request.matchAt.toISOString(),
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    counts: {
      requestsPosted: u._count.requestsCreated,
      applications: u._count.applications,
      ratingsReceived: u._count.ratingsReceived,
      ratingsGiven: u._count.ratingsGiven,
      reportsFiled: u._count.reportsFiled,
      reportsAgainst: reportsAgainst.length,
    },
    reportsAgainst: reportsAgainst.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      details: r.details,
      reporterName: r.reporter.name,
      createdAt: r.createdAt.toISOString(),
    })),
    reportsFiled: reportsFiled.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    auditHistory: auditHistory.map(toAction),
  };
}

async function loadTargetUser(adminId: string, id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true, role: true } });
  if (!u) throw AppError.notFound("USER_NOT_FOUND", "User not found");
  if (u.id === adminId) throw AppError.forbidden("ADMIN_CANNOT_TARGET_SELF", "You can't do that to yourself");
  if (u.role === "ADMIN") throw AppError.forbidden("ADMIN_CANNOT_TARGET_ADMIN", "Admins can't be moderated through the API");
  return u;
}

export async function suspendUser(adminId: string, id: string, reason: string) {
  const target = await loadTargetUser(adminId, id);
  if (target.status === "DELETED") throw AppError.conflict("USER_DELETED", "That account was deleted");
  if (target.status === "SUSPENDED") throw AppError.conflict("USER_ALREADY_SUSPENDED", "Already suspended");

  const effects = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "SUSPENDED" } });
    await revokeAllForUser(id, tx);
    const effects = await retireParticipation(tx, id);
    await audit(tx, adminId, "USER_SUSPEND", "USER", id, reason);
    return effects;
  });
  for (const e of effects) notify(e);
  return getUser(id);
}

export async function banUser(adminId: string, id: string, input: { reason: string; durationDays?: number }) {
  const target = await loadTargetUser(adminId, id);
  if (target.status === "DELETED") throw AppError.conflict("USER_DELETED", "That account was deleted");

  const effects = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "SUSPENDED" } });
    await revokeAllForUser(id, tx);
    const effects = await retireParticipation(tx, id);
    await audit(tx, adminId, "USER_SUSPEND", "USER", id, input.reason, {
      ban: true,
      durationDays: input.durationDays ?? null,
      permanent: !input.durationDays,
    });
    return effects;
  });
  for (const e of effects) notify(e);
  return getUser(id);
}

export async function resetUserSessions(adminId: string, id: string) {
  await loadTargetUser(adminId, id);
  await revokeAllForUser(id);
  await prisma.$transaction(async (tx) => {
    await audit(tx, adminId, "USER_ROLE_CHANGE", "USER", id, "Force logout: active sessions revoked", {
      action: "RESET_SESSIONS",
    });
  });
  return { success: true, message: "User sessions revoked" };
}

export async function deleteUser(adminId: string, id: string, reason: string) {
  const target = await loadTargetUser(adminId, id);
  if (target.status === "DELETED") throw AppError.conflict("USER_ALREADY_DELETED", "Account already deleted");

  const effects = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "DELETED", deletedAt: new Date() } });
    await revokeAllForUser(id, tx);
    const effects = await retireParticipation(tx, id);
    await audit(tx, adminId, "USER_SUSPEND", "USER", id, reason, { action: "SOFT_DELETE" });
    return effects;
  });
  for (const e of effects) notify(e);
  return { success: true, message: "User account soft deleted" };
}

export async function unsuspendUser(adminId: string, id: string, reason?: string) {
  const target = await loadTargetUser(adminId, id);
  if (target.status !== "SUSPENDED") throw AppError.conflict("USER_NOT_SUSPENDED", "That user isn't suspended");
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: "ACTIVE" } });
    await audit(tx, adminId, "USER_UNSUSPEND", "USER", id, reason);
  });
  return getUser(id);
}

export async function me(adminId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: adminId },
    select: { id: true, name: true, email: true, role: true, avatarUrl: true },
  });
}

export async function changeAdminPassword(adminId: string, current: string, next: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  if (!u.passwordHash || !(await verifyPassword(u.passwordHash, current))) {
    throw AppError.unauthorized("INVALID_PASSWORD", "Current password is incorrect");
  }
  const passwordHash = await hashPassword(next);
  await prisma.user.update({ where: { id: adminId }, data: { passwordHash } });
  return { success: true };
}

export async function setUserRole(adminId: string, id: string, role: "PLAYER" | "RECRUITER", reason: string) {
  const target = await loadTargetUser(adminId, id);
  if (target.status === "DELETED") throw AppError.conflict("USER_DELETED", "That account was deleted");
  if (target.role === role) throw AppError.conflict("USER_ROLE_UNCHANGED", `Already a ${role.toLowerCase()}`);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { role } });
    await audit(tx, adminId, "USER_ROLE_CHANGE", "USER", id, reason, { from: target.role, to: role });
  });
  return getUser(id);
}

// ───────────────────────── player & recruiter directories ─────────────────────────

const playerListInclude = {
  user: { select: { id: true, name: true, email: true, phone: true, status: true, avatarUrl: true } },
  district: { select: { id: true, nameEn: true, nameBn: true } },
  upazila: { select: { id: true, nameEn: true, nameBn: true } },
  sports: {
    orderBy: { createdAt: "asc" },
    include: { sport: { select: { id: true, code: true, nameEn: true } }, _count: { select: { achievements: true } } },
  },
} satisfies Prisma.PlayerProfileInclude;

export async function listPlayers(q: z.infer<typeof playersQuery>) {
  const rows = await prisma.playerProfile.findMany({
    where: {
      ...(q.q && {
        user: {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { email: { contains: q.q, mode: "insensitive" } },
            { phone: { contains: q.q } },
          ],
        },
      }),
      ...(q.sportId && { sports: { some: { sportId: q.sportId } } }),
      ...(q.districtId && { districtId: q.districtId }),
      ...(q.hidden === true && {
        OR: [{ hiddenByAdminAt: { not: null } }, { sports: { some: { hiddenByAdminAt: { not: null } } } }],
      }),
      ...(q.hidden === false && { hiddenByAdminAt: null, sports: { none: { hiddenByAdminAt: { not: null } } } }),
    },
    include: playerListInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((p) => ({
      id: p.id,
      user: p.user,
      location: `${p.upazila.nameEn}, ${p.district.nameEn}`,
      districtId: p.district.id,
      isVisible: p.isVisible,
      hiddenByAdmin: p.hiddenByAdminAt !== null,
      verifiedBadge: p.verifiedBadge,
      rating: { average: Math.round(p.avgRating * 100) / 100, count: p.ratingCount },
      noShowCount: p.noShowCount,
      sportProfiles: p.sports.map((s) => ({
        id: s.id,
        sportId: s.sportId,
        sportCode: s.sport.code,
        sportName: s.sport.nameEn,
        positions: s.positions,
        headline: s.headline,
        experienceYears: s.experienceYears,
        isVisible: s.isVisible,
        hiddenByAdmin: s.hiddenByAdminAt !== null,
        rating: { average: Math.round(s.avgRating * 100) / 100, count: s.ratingCount },
        achievements: s._count.achievements,
      })),
      createdAt: p.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function listRecruiters(q: z.infer<typeof recruitersQuery>) {
  const rows = await prisma.recruiterProfile.findMany({
    where: {
      ...(q.verified !== undefined && { verifiedBadge: q.verified }),
      ...(q.districtId && { districtId: q.districtId }),
      ...(q.q && {
        OR: [
          { organization: { contains: q.q, mode: "insensitive" } },
          { user: { name: { contains: q.q, mode: "insensitive" } } },
          { user: { email: { contains: q.q, mode: "insensitive" } } },
          { user: { phone: { contains: q.q } } },
        ],
      }),
    },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, status: true, avatarUrl: true } },
      district: { select: { id: true, nameEn: true, nameBn: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({
      id: r.id,
      user: r.user,
      type: r.type,
      organization: r.organization,
      district: r.district.nameEn,
      districtId: r.district.id,
      sportIds: r.sportIds,
      verifiedBadge: r.verifiedBadge,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function setRecruiterVerified(adminId: string, recruiterId: string, verified: boolean) {
  const r = await prisma.recruiterProfile.findUnique({ where: { id: recruiterId }, select: { id: true, verifiedBadge: true } });
  if (!r) throw AppError.notFound("RECRUITER_PROFILE_NOT_FOUND", "Recruiter not found");
  if (r.verifiedBadge === verified) return { id: r.id, verifiedBadge: r.verifiedBadge };
  return prisma.$transaction(async (tx) => {
    const updated = await tx.recruiterProfile.update({ where: { id: recruiterId }, data: { verifiedBadge: verified } });
    await audit(tx, adminId, verified ? "RECRUITER_VERIFY" : "RECRUITER_UNVERIFY", "RECRUITER", recruiterId);
    return { id: updated.id, verifiedBadge: updated.verifiedBadge };
  });
}

export async function setPlayerProfileHidden(adminId: string, profileId: string, hidden: boolean, reason?: string) {
  const p = await prisma.playerProfile.findUnique({ where: { id: profileId }, select: { id: true, hiddenByAdminAt: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player profile not found");
  if (hidden === (p.hiddenByAdminAt !== null)) {
    throw AppError.conflict(hidden ? "PROFILE_ALREADY_HIDDEN" : "PROFILE_NOT_HIDDEN", hidden ? "Already hidden" : "Not hidden");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerProfile.update({
      where: { id: profileId },
      data: { hiddenByAdminAt: hidden ? new Date() : null },
    });
    await audit(tx, adminId, hidden ? "PROFILE_HIDE" : "PROFILE_UNHIDE", "PLAYER_PROFILE", profileId, reason);
    return { id: updated.id, hiddenByAdmin: updated.hiddenByAdminAt !== null };
  });
}

export async function setPlayerProfileVerified(adminId: string, profileId: string, verified: boolean) {
  const p = await prisma.playerProfile.findUnique({ where: { id: profileId }, select: { id: true, verifiedBadge: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player profile not found");
  if (p.verifiedBadge === verified) return { id: p.id, verifiedBadge: p.verifiedBadge };
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerProfile.update({ where: { id: profileId }, data: { verifiedBadge: verified } });
    await audit(tx, adminId, verified ? "PROFILE_VERIFY" : "PROFILE_UNVERIFY", "PLAYER_PROFILE", profileId);
    return { id: updated.id, verifiedBadge: updated.verifiedBadge };
  });
}

// ───────────────────────── sport profiles ─────────────────────────

export async function listSportProfiles(q: z.infer<typeof sportProfilesQuery>) {
  const where: Prisma.PlayerSportWhereInput = {
    ...(q.sportId && { sportId: q.sportId }),
    ...(q.position && { positions: { has: q.position } }),
    ...(q.districtId && { profile: { districtId: q.districtId } }),
    ...(q.khep !== undefined && { khepAvailable: q.khep }),
    ...(q.hidden === true && { hiddenByAdminAt: { not: null } }),
    ...(q.hidden === false && { hiddenByAdminAt: null }),
    ...(q.minRating !== undefined && { avgRating: { gte: q.minRating } }),
    ...(q.q && {
      profile: {
        user: {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { email: { contains: q.q, mode: "insensitive" } },
            { phone: { contains: q.q } },
          ],
        },
      },
    }),
  };

  const rows = await prisma.playerSport.findMany({
    where,
    include: {
      sport: { select: { id: true, code: true, nameEn: true, nameBn: true } },
      profile: {
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true, status: true } },
          district: { select: { id: true, nameEn: true, nameBn: true } },
          upazila: { select: { id: true, nameEn: true, nameBn: true } },
        },
      },
      _count: { select: { achievements: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });

  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((s) => ({
      id: s.id,
      profileId: s.profileId,
      player: {
        id: s.profile.user.id,
        name: s.profile.user.name,
        email: s.profile.user.email,
        phone: s.profile.user.phone,
        avatarUrl: s.profile.user.avatarUrl,
        status: s.profile.user.status,
      },
      location: `${s.profile.upazila.nameEn}, ${s.profile.district.nameEn}`,
      districtId: s.profile.district.id,
      sport: s.sport,
      positions: s.positions,
      headline: s.headline,
      experienceYears: s.experienceYears,
      currentTeam: s.currentTeam,
      khepAvailable: s.khepAvailable,
      rates: { min: s.rateMin, max: s.rateMax },
      stats: s.stats,
      rating: { average: Math.round(s.avgRating * 100) / 100, count: s.ratingCount },
      achievementsCount: s._count.achievements,
      hiddenByAdmin: s.hiddenByAdminAt !== null,
      isVisible: s.isVisible,
      createdAt: s.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getSportProfile(id: string) {
  const sp = await prisma.playerSport.findUnique({
    where: { id },
    include: {
      sport: true,
      achievements: { orderBy: { year: "desc" } },
      profile: {
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true, status: true } },
          district: true,
          upazila: true,
          media: { orderBy: { order: "asc" } },
        },
      },
    },
  });
  if (!sp) throw AppError.notFound("SPORT_PROFILE_NOT_FOUND", "Sport profile not found");
  return {
    id: sp.id,
    profileId: sp.profileId,
    player: sp.profile.user,
    location: `${sp.profile.upazila.nameEn}, ${sp.profile.district.nameEn}`,
    sport: sp.sport,
    positions: sp.positions,
    headline: sp.headline,
    experienceYears: sp.experienceYears,
    currentTeam: sp.currentTeam,
    skillLevel: sp.skillLevel,
    khepAvailable: sp.khepAvailable,
    rates: { min: sp.rateMin, max: sp.rateMax },
    stats: sp.stats,
    rating: { average: sp.avgRating, count: sp.ratingCount },
    achievements: sp.achievements,
    media: sp.profile.media,
    hiddenByAdmin: sp.hiddenByAdminAt !== null,
    isVisible: sp.isVisible,
    createdAt: sp.createdAt.toISOString(),
  };
}

export async function updateSportProfile(adminId: string, id: string, input: z.infer<typeof updateSportProfileBody>) {
  const sp = await prisma.playerSport.findUnique({ where: { id } });
  if (!sp) throw AppError.notFound("SPORT_PROFILE_NOT_FOUND", "Sport profile not found");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerSport.update({
      where: { id },
      data: {
        ...(input.headline !== undefined && { headline: input.headline }),
        ...(input.experienceYears !== undefined && { experienceYears: input.experienceYears }),
        ...(input.currentTeam !== undefined && { currentTeam: input.currentTeam }),
      },
    });
    await audit(tx, adminId, "SPORT_PROFILE_HIDE", "PLAYER_SPORT", id, input.reason, {
      action: "MODERATE_SPORT_PROFILE",
      headline: input.headline,
      experienceYears: input.experienceYears,
      currentTeam: input.currentTeam,
    });
    return updated;
  });
}

export async function deleteSportMedia(adminId: string, sportProfileId: string, mediaId: string) {
  const sp = await prisma.playerSport.findUnique({ where: { id: sportProfileId }, select: { profileId: true } });
  if (!sp) throw AppError.notFound("SPORT_PROFILE_NOT_FOUND", "Sport profile not found");

  const media = await prisma.playerMedia.findFirst({ where: { id: mediaId, profileId: sp.profileId } });
  if (!media) throw AppError.notFound("MEDIA_NOT_FOUND", "Media not found");

  return prisma.$transaction(async (tx) => {
    await tx.playerMedia.delete({ where: { id: mediaId } });
    await audit(tx, adminId, "SPORT_PROFILE_HIDE", "PLAYER_MEDIA", mediaId, "Inappropriate media removed by admin");
    return { success: true };
  });
}

export async function setSportProfileHidden(adminId: string, id: string, hidden: boolean, reason?: string) {
  const sp = await prisma.playerSport.findUnique({ where: { id }, select: { id: true, hiddenByAdminAt: true } });
  if (!sp) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "Sport profile not found");
  if (hidden === (sp.hiddenByAdminAt !== null)) {
    throw AppError.conflict(hidden ? "SPORT_PROFILE_ALREADY_HIDDEN" : "SPORT_PROFILE_NOT_HIDDEN", hidden ? "Already hidden" : "Not hidden");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerSport.update({ where: { id }, data: { hiddenByAdminAt: hidden ? new Date() : null } });
    await audit(tx, adminId, hidden ? "SPORT_PROFILE_HIDE" : "SPORT_PROFILE_UNHIDE", "PLAYER_SPORT", id, reason);
    return { id: updated.id, hiddenByAdmin: updated.hiddenByAdminAt !== null };
  });
}

// ───────────────────────── requests & applications ─────────────────────────

export async function listRequests(q: z.infer<typeof requestsAdminQuery>) {
  const rows = await prisma.playerRequest.findMany({
    where: {
      ...(q.sportId && { sportId: q.sportId }),
      ...(q.districtId && { districtId: q.districtId }),
      ...(q.status && { status: q.status }),
      ...(q.hidden !== undefined && { isHidden: q.hidden }),
      ...(q.isPaid !== undefined && { isPaid: q.isPaid }),
      ...(q.q && {
        OR: [
          { venueText: { contains: q.q, mode: "insensitive" } },
          { notes: { contains: q.q, mode: "insensitive" } },
          { createdBy: { name: { contains: q.q, mode: "insensitive" } } },
        ],
      }),
    },
    include: {
      sport: { select: { id: true, code: true, nameEn: true, nameBn: true } },
      district: { select: { id: true, nameEn: true, nameBn: true } },
      upazila: { select: { id: true, nameEn: true, nameBn: true } },
      createdBy: { select: { id: true, name: true, email: true, phone: true } },
      _count: { select: { applications: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });

  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({
      id: r.id,
      poster: r.createdBy,
      sport: r.sport,
      location: `${r.upazila.nameEn}, ${r.district.nameEn}`,
      venueText: r.venueText,
      matchAt: r.matchAt.toISOString(),
      positionsNeeded: r.positionsNeeded,
      playersNeeded: r.playersNeeded,
      playersAccepted: r.playersAccepted,
      isPaid: r.isPaid,
      budget: { min: r.budgetMin, max: r.budgetMax },
      status: r.status,
      isHidden: r.isHidden,
      applicationsCount: r._count.applications,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getRequest(id: string) {
  const r = await prisma.playerRequest.findUnique({
    where: { id },
    include: {
      sport: true,
      district: true,
      upazila: true,
      createdBy: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
      applications: {
        include: {
          player: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              avatarUrl: true,
              playerProfile: { select: { id: true, avgRating: true, ratingCount: true, verifiedBadge: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!r) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  return {
    id: r.id,
    poster: r.createdBy,
    sport: r.sport,
    location: `${r.upazila.nameEn}, ${r.district.nameEn}`,
    venueText: r.venueText,
    matchAt: r.matchAt.toISOString(),
    positionsNeeded: r.positionsNeeded,
    playersNeeded: r.playersNeeded,
    playersAccepted: r.playersAccepted,
    isPaid: r.isPaid,
    budget: { min: r.budgetMin, max: r.budgetMax },
    notes: r.notes,
    status: r.status,
    isHidden: r.isHidden,
    applications: r.applications.map((a) => ({
      id: a.id,
      status: a.status,
      proposedRate: a.proposedRate,
      message: a.message,
      player: {
        id: a.player.id,
        name: a.player.name,
        email: a.player.email,
        phone: a.player.phone,
        avatarUrl: a.player.avatarUrl,
        rating: a.player.playerProfile?.avgRating ?? 0,
        verifiedBadge: a.player.playerProfile?.verifiedBadge ?? false,
      },
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function cancelRequest(adminId: string, id: string, reason: string) {
  const r = await prisma.playerRequest.findUnique({ where: { id }, select: { id: true, status: true, createdById: true } });
  if (!r) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  if (r.status === "CANCELLED") throw AppError.conflict("REQUEST_ALREADY_CANCELLED", "Already cancelled");

  return prisma.$transaction(async (tx) => {
    await tx.playerRequest.update({ where: { id }, data: { status: "CANCELLED" } });
    await tx.application.updateMany({ where: { requestId: id, status: "PENDING" }, data: { status: "REJECTED" } });
    await audit(tx, adminId, "REQUEST_HIDE", "REQUEST", id, reason, { action: "ADMIN_CANCEL_REQUEST" });
    return { id, status: "CANCELLED" };
  });
}

export async function setRequestHidden(adminId: string, requestId: string, hidden: boolean, reason?: string) {
  const r = await prisma.playerRequest.findUnique({ where: { id: requestId }, select: { id: true, isHidden: true, status: true } });
  if (!r) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  if (r.isHidden === hidden) {
    throw AppError.conflict(hidden ? "REQUEST_ALREADY_HIDDEN" : "REQUEST_NOT_HIDDEN", hidden ? "Already hidden" : "Not hidden");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerRequest.update({ where: { id: requestId }, data: { isHidden: hidden } });
    await audit(tx, adminId, hidden ? "REQUEST_HIDE" : "REQUEST_UNHIDE", "REQUEST", requestId, reason);
    return { id: updated.id, isHidden: updated.isHidden, status: updated.status };
  });
}

export async function listApplications(q: z.infer<typeof applicationsAdminQuery>) {
  const rows = await prisma.application.findMany({
    where: {
      ...(q.status && { status: q.status }),
      ...(q.requestId && { requestId: q.requestId }),
      ...(q.playerId && { playerId: q.playerId }),
    },
    include: {
      player: { select: { id: true, name: true, email: true, phone: true } },
      request: {
        include: {
          sport: { select: { nameEn: true } },
          district: { select: { nameEn: true } },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });

  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      player: a.player,
      sport: a.request.sport.nameEn,
      district: a.request.district.nameEn,
      matchAt: a.request.matchAt.toISOString(),
      proposedRate: a.proposedRate,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

// ───────────────────────── reports ─────────────────────────

const reportInclude = { reporter: { select: { id: true, name: true } } } satisfies Prisma.ReportInclude;
type ReportRow = Prisma.ReportGetPayload<{ include: typeof reportInclude }>;

const toReport = (r: ReportRow, reportsOnTarget?: number) => ({
  id: r.id,
  status: r.status,
  targetType: r.targetType,
  targetId: r.targetId,
  reason: r.reason,
  details: r.details,
  reporter: r.reporter,
  createdAt: r.createdAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
  resolvedById: r.resolvedById,
  resolution: r.resolution,
  ...(reportsOnTarget !== undefined && { openReportsOnTarget: reportsOnTarget }),
});

export async function listReports(q: z.infer<typeof reportsQuery>) {
  const rows = await prisma.report.findMany({
    where: { ...(q.status !== "ALL" && { status: q.status as ReportStatus }), ...(q.targetType && { targetType: q.targetType }) },
    include: reportInclude,
    orderBy: q.status === "OPEN" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  const counts = await Promise.all(items.map((r) => prisma.report.count({ where: { targetType: r.targetType, targetId: r.targetId, status: "OPEN" } })));
  return { items: items.map((r, i) => toReport(r, counts[i])), nextCursor };
}

async function describeTarget(type: string, id: string) {
  switch (type) {
    case "PLAYER_PROFILE": {
      const p = await prisma.playerProfile.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, status: true } } } });
      return p && { kind: type, profileId: p.id, userId: p.user.id, name: p.user.name, userStatus: p.user.status, isVisible: p.isVisible, hiddenByAdmin: p.hiddenByAdminAt !== null, verifiedBadge: p.verifiedBadge, noShowCount: p.noShowCount };
    }
    case "REQUEST": {
      const r = await prisma.playerRequest.findUnique({ where: { id }, include: { createdBy: { select: { id: true, name: true } } } });
      return r && { kind: type, requestId: r.id, venueText: r.venueText, notes: r.notes, status: r.status, isHidden: r.isHidden, matchAt: r.matchAt.toISOString(), posterId: r.createdBy.id, posterName: r.createdBy.name };
    }
    case "TEAM": {
      const t = await prisma.team.findUnique({ where: { id } });
      return t && { kind: type, teamId: t.id, name: t.name, captainId: t.captainId };
    }
    case "RATING": {
      const r = await prisma.rating.findUnique({ where: { id } });
      return r && { kind: type, ratingId: r.id, requestId: r.requestId, raterId: r.raterId, rateeId: r.rateeId, direction: r.direction, overall: r.overall, noShow: r.noShow, comment: r.comment };
    }
    case "USER": {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
      return u && { kind: type, userId: u.id, name: u.name, status: u.status };
    }
    default:
      return null;
  }
}

export async function getReport(id: string) {
  const r = await prisma.report.findUnique({ where: { id }, include: { ...reportInclude, reporter: { select: { id: true, name: true, email: true } } } });
  if (!r) throw AppError.notFound("REPORT_NOT_FOUND", "Report not found");
  const [target, history, others] = await Promise.all([
    describeTarget(r.targetType, r.targetId),
    prisma.adminAction.findMany({ where: { targetType: r.targetType, targetId: r.targetId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.report.count({ where: { targetType: r.targetType, targetId: r.targetId, status: "OPEN" } }),
  ]);
  return { ...toReport(r, others), reporter: r.reporter, target, targetMissing: target === null, history: history.map(toAction) };
}

export async function resolveReport(adminId: string, id: string, input: { outcome: "RESOLVED" | "DISMISSED"; resolution: string }) {
  const r = await prisma.report.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!r) throw AppError.notFound("REPORT_NOT_FOUND", "Report not found");
  if (r.status !== "OPEN") throw AppError.conflict("REPORT_ALREADY_RESOLVED", `Report is already ${r.status.toLowerCase()}`);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.report.updateMany({
      where: { id, status: "OPEN" },
      data: { status: input.outcome, resolvedById: adminId, resolvedAt: new Date(), resolution: input.resolution },
    });
    if (count === 0) throw AppError.conflict("REPORT_ALREADY_RESOLVED", "Someone else just handled this report");
    await audit(tx, adminId, input.outcome === "RESOLVED" ? "REPORT_RESOLVE" : "REPORT_DISMISS", "REPORT", id, input.resolution);
  });
  return getReport(id);
}

// ───────────────────────── Sports & Positions CRUD ─────────────────────────

export async function listSports() {
  const sports = await prisma.sport.findMany({
    include: {
      positions: { orderBy: { order: "asc" } },
      _count: { select: { playerSports: true, requests: true } },
    },
    orderBy: { id: "asc" },
  });
  return sports.map((s) => ({
    id: s.id,
    code: s.code,
    nameEn: s.nameEn,
    nameBn: s.nameBn,
    isActive: s.isActive,
    positions: s.positions,
    playersCount: s._count.playerSports,
    requestsCount: s._count.requests,
  }));
}

export async function createSport(adminId: string, input: z.infer<typeof createSportBody>) {
  const exists = await prisma.sport.findUnique({ where: { code: input.code } });
  if (exists) throw AppError.conflict("SPORT_CODE_EXISTS", `Sport with code ${input.code} already exists`);

  return prisma.$transaction(async (tx) => {
    const s = await tx.sport.create({ data: input });
    await audit(tx, adminId, "CONFIG_SET", "SPORT", String(s.id), `Created sport ${s.code}`);
    return s;
  });
}

export async function updateSport(adminId: string, id: number, input: z.infer<typeof updateSportBody>) {
  const s = await prisma.sport.findUnique({ where: { id } });
  if (!s) throw AppError.notFound("SPORT_NOT_FOUND", "Sport not found");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.sport.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "SPORT", String(id), `Updated sport ${s.code}`, { changes: input });
    return updated;
  });
}

export async function createPosition(adminId: string, sportId: number, input: z.infer<typeof createPositionBody>) {
  const sport = await prisma.sport.findUnique({ where: { id: sportId } });
  if (!sport) throw AppError.notFound("SPORT_NOT_FOUND", "Sport not found");

  const exists = await prisma.position.findUnique({ where: { sportId_code: { sportId, code: input.code } } });
  if (exists) throw AppError.conflict("POSITION_EXISTS", `Position ${input.code} already exists for this sport`);

  return prisma.$transaction(async (tx) => {
    const pos = await tx.position.create({ data: { ...input, sportId } });
    await audit(tx, adminId, "CONFIG_SET", "POSITION", String(pos.id), `Added position ${input.code} to ${sport.code}`);
    return pos;
  });
}

export async function updatePosition(adminId: string, id: number, input: z.infer<typeof updatePositionBody>) {
  const pos = await prisma.position.findUnique({ where: { id } });
  if (!pos) throw AppError.notFound("POSITION_NOT_FOUND", "Position not found");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.position.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "POSITION", String(id), `Updated position ${pos.code}`, { changes: input });
    return updated;
  });
}

export async function deletePosition(adminId: string, id: number) {
  const pos = await prisma.position.findUnique({ where: { id } });
  if (!pos) throw AppError.notFound("POSITION_NOT_FOUND", "Position not found");

  return prisma.$transaction(async (tx) => {
    await tx.position.delete({ where: { id } });
    await audit(tx, adminId, "CONFIG_SET", "POSITION", String(id), `Deleted position ${pos.code}`);
    return { success: true };
  });
}

// ───────────────────────── Locations (Bangladesh) ─────────────────────────

export async function listDivisions() {
  const divs = await prisma.division.findMany({
    include: { _count: { select: { districts: true } } },
    orderBy: { nameEn: "asc" },
  });
  return divs.map((d) => ({
    id: d.id,
    code: d.code,
    nameEn: d.nameEn,
    nameBn: d.nameBn,
    slug: d.slug,
    districtsCount: d._count.districts,
  }));
}

export async function updateDivision(adminId: string, id: number, input: z.infer<typeof updateLocationBody>) {
  const d = await prisma.division.findUnique({ where: { id } });
  if (!d) throw AppError.notFound("DIVISION_NOT_FOUND", "Division not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.division.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "DIVISION", String(id), `Updated division ${d.slug}`);
    return updated;
  });
}

export async function listDistricts(divisionId?: number) {
  const rows = await prisma.district.findMany({
    where: { ...(divisionId && { divisionId }) },
    include: {
      division: { select: { id: true, nameEn: true, nameBn: true } },
      _count: { select: { upazilas: true, profiles: true, requests: true } },
    },
    orderBy: { nameEn: "asc" },
  });
  return rows.map((d) => ({
    id: d.id,
    divisionId: d.divisionId,
    division: d.division,
    nameEn: d.nameEn,
    nameBn: d.nameBn,
    slug: d.slug,
    upazilasCount: d._count.upazilas,
    playersCount: d._count.profiles,
    requestsCount: d._count.requests,
  }));
}

export async function updateDistrict(adminId: string, id: number, input: z.infer<typeof updateLocationBody>) {
  const d = await prisma.district.findUnique({ where: { id } });
  if (!d) throw AppError.notFound("DISTRICT_NOT_FOUND", "District not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.district.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "DISTRICT", String(id), `Updated district ${d.slug}`);
    return updated;
  });
}

export async function listUpazilas(districtId?: number) {
  const rows = await prisma.upazila.findMany({
    where: { ...(districtId && { districtId }) },
    include: {
      district: { select: { id: true, nameEn: true, nameBn: true } },
      _count: { select: { unions: true, profiles: true } },
    },
    orderBy: { nameEn: "asc" },
  });
  return rows.map((u) => ({
    id: u.id,
    districtId: u.districtId,
    district: u.district,
    nameEn: u.nameEn,
    nameBn: u.nameBn,
    slug: u.slug,
    unionsCount: u._count.unions,
    playersCount: u._count.profiles,
  }));
}

export async function updateUpazila(adminId: string, id: number, input: z.infer<typeof updateLocationBody>) {
  const u = await prisma.upazila.findUnique({ where: { id } });
  if (!u) throw AppError.notFound("UPAZILA_NOT_FOUND", "Upazila not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.upazila.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "UPAZILA", String(id), `Updated upazila ${u.slug}`);
    return updated;
  });
}

export async function listUnions(upazilaId?: number) {
  return prisma.union.findMany({
    where: { ...(upazilaId && { upazilaId }) },
    include: { upazila: { select: { id: true, nameEn: true, nameBn: true } } },
    orderBy: { nameEn: "asc" },
  });
}

export async function updateUnion(adminId: string, id: number, input: z.infer<typeof updateLocationBody>) {
  const u = await prisma.union.findUnique({ where: { id } });
  if (!u) throw AppError.notFound("UNION_NOT_FOUND", "Union not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.union.update({ where: { id }, data: input });
    await audit(tx, adminId, "CONFIG_SET", "UNION", String(id), `Updated union ${u.slug}`);
    return updated;
  });
}

// ───────────────────────── Push Announcements ─────────────────────────

function buildNotificationTargetWhere(filters: z.infer<typeof notificationFilterQuery>): Prisma.UserWhereInput {
  return {
    status: "ACTIVE",
    ...(filters.role && { role: filters.role as UserRole }),
    ...(filters.districtId && {
      OR: [
        { playerProfile: { districtId: filters.districtId } },
        { recruiterProfile: { districtId: filters.districtId } },
      ],
    }),
    ...(filters.divisionId && {
      OR: [
        { playerProfile: { district: { divisionId: filters.divisionId } } },
        { recruiterProfile: { district: { divisionId: filters.divisionId } } },
      ],
    }),
    ...(filters.sportId && {
      playerProfile: { sports: { some: { sportId: filters.sportId } } },
    }),
  };
}

export async function previewNotificationCount(filters: z.infer<typeof notificationFilterQuery>) {
  const count = await prisma.user.count({ where: buildNotificationTargetWhere(filters) });
  return { targetCount: count };
}

export async function broadcastNotification(adminId: string, input: z.infer<typeof broadcastNotificationBody>) {
  const where = buildNotificationTargetWhere({
    role: input.role,
    sportId: input.sportId,
    divisionId: input.divisionId,
    districtId: input.districtId,
  });

  const recipients = await prisma.user.findMany({
    where,
    select: { id: true },
  });

  const userIds = recipients.map((r) => r.id);

  if (userIds.length > 0) {
    // Write in-app Notification records in chunks
    const chunk = 500;
    for (let i = 0; i < userIds.length; i += chunk) {
      const slice = userIds.slice(i, i + chunk);
      await prisma.notification.createMany({
        data: slice.map((uid) => ({
          userId: uid,
          type: "SYSTEM",
          title: input.title,
          body: input.body,
          data: {},
        })),
      });
    }

    // Trigger push notifications
    notify({
      userIds,
      type: "SYSTEM",
      data: { title: input.title, body: input.body },
      params: { sport: { en: "", bn: "" }, venue: "", when: new Date() },
    });
  }

  await prisma.$transaction(async (tx) => {
    await audit(tx, adminId, "CONFIG_SET", "NOTIFICATION", "BROADCAST", input.title, {
      title: input.title,
      body: input.body,
      recipientCount: userIds.length,
      filters: { role: input.role, sportId: input.sportId, divisionId: input.divisionId, districtId: input.districtId },
    });
  });

  return { sentCount: userIds.length };
}

// ───────────────────────── overview & analytics ─────────────────────────

const DAY = 86_400_000;

export async function stats() {
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * DAY);
  const sevenDaysAgo = new Date(now - 7 * DAY);
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

  const [
    byRole,
    byStatus,
    newToday,
    new7,
    new30,
    profiles,
    verifiedProfiles,
    hiddenProfiles,
    perSport,
    recruiters,
    verifiedRecruiters,
    requestsByStatus,
    totalApplications,
    applicationsByStatus,
    openReports,
    resolvedReports,
    dismissedReports,
    actions24h,
    usersLast30Days,
    requestsLast30Days,
    appsLast30Days,
    topDistricts,
    sportsList,
    recentActions,
    recentSignups,
    recentReports,
  ] = await Promise.all([
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.playerProfile.count(),
    prisma.playerProfile.count({ where: { verifiedBadge: true } }),
    prisma.playerProfile.count({ where: { hiddenByAdminAt: { not: null } } }),
    prisma.playerSport.groupBy({ by: ["sportId"], _count: { _all: true } }),
    prisma.recruiterProfile.count(),
    prisma.recruiterProfile.count({ where: { verifiedBadge: true } }),
    prisma.playerRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.application.count(),
    prisma.application.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.report.count({ where: { status: "OPEN" } }),
    prisma.report.count({ where: { status: "RESOLVED" } }),
    prisma.report.count({ where: { status: "DISMISSED" } }),
    prisma.adminAction.count({ where: { createdAt: { gte: new Date(now - DAY) } } }),
    prisma.user.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, role: true },
    }),
    prisma.playerRequest.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    }),
    prisma.application.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    }),
    prisma.district.findMany({
      include: { _count: { select: { profiles: true, recruiters: true, requests: true } } },
      orderBy: { profiles: { _count: "desc" } },
      take: 8,
    }),
    prisma.sport.findMany({ select: { id: true, code: true, nameEn: true, nameBn: true, isActive: true } }),
    prisma.adminAction.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    }),
    prisma.report.findMany({
      where: { status: "OPEN" },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { reporter: { select: { name: true } } },
    }),
  ]);

  const count = <K extends string>(rows: Array<Record<K, string> & { _count: { _all: number } }>, key: K) =>
    Object.fromEntries(rows.map((r) => [r[key], r._count._all]));

  // Build daily 30-day time series
  const daysMap = new Map<string, { date: string; total: number; players: number; recruiters: number; requests: number; applications: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = d.toISOString().split("T")[0]!;
    daysMap.set(key, { date: key, total: 0, players: 0, recruiters: 0, requests: 0, applications: 0 });
  }

  for (const u of usersLast30Days) {
    const key = u.createdAt.toISOString().split("T")[0]!;
    const entry = daysMap.get(key);
    if (entry) {
      entry.total++;
      if (u.role === "PLAYER") entry.players++;
      if (u.role === "RECRUITER") entry.recruiters++;
    }
  }

  for (const r of requestsLast30Days) {
    const key = r.createdAt.toISOString().split("T")[0]!;
    const entry = daysMap.get(key);
    if (entry) entry.requests++;
  }

  for (const a of appsLast30Days) {
    const key = a.createdAt.toISOString().split("T")[0]!;
    const entry = daysMap.get(key);
    if (entry) entry.applications++;
  }

  const timeseries = Array.from(daysMap.values());
  const reqCounts = count(requestsByStatus, "status");

  return {
    summary: {
      users: {
        total: byRole.reduce((acc, r) => acc + r._count._all, 0),
        byRole: count(byRole, "role"),
        byStatus: count(byStatus, "status"),
        signupsToday: newToday,
        signupsLast7Days: new7,
        signupsLast30Days: new30,
      },
      players: {
        totalProfiles: profiles,
        verifiedProfiles,
        hiddenByAdmin: hiddenProfiles,
      },
      recruiters: {
        totalProfiles: recruiters,
        verifiedProfiles: verifiedRecruiters,
      },
      requests: {
        total: requestsByStatus.reduce((acc, r) => acc + r._count._all, 0),
        byStatus: reqCounts,
        openCount: reqCounts["OPEN"] ?? 0,
        completedMatches: (reqCounts["FULFILLED"] ?? 0) + (reqCounts["COMPLETED"] ?? 0) + (reqCounts["MATCHED"] ?? 0),
      },
      applications: {
        total: totalApplications,
        byStatus: count(applicationsByStatus, "status"),
      },
      moderation: {
        openReports,
        resolvedReports,
        dismissedReports,
        actionsLast24h: actions24h,
      },
    },
    charts: {
      signupsTrend: timeseries.map(({ date, total, players, recruiters }) => ({ date, total, players, recruiters })),
      activityTrend: timeseries.map(({ date, requests, applications }) => ({ date, requests, applications })),
      sportsDistribution: perSport.map((r) => {
        const sp = sportsList.find((s) => s.id === r.sportId);
        return {
          sportId: r.sportId,
          code: sp?.code ?? "?",
          nameEn: sp?.nameEn ?? "?",
          nameBn: sp?.nameBn ?? "?",
          count: r._count._all,
        };
      }),
      topDistricts: topDistricts.map((d) => ({
        id: d.id,
        nameEn: d.nameEn,
        nameBn: d.nameBn,
        players: d._count.profiles,
        recruiters: d._count.recruiters,
        requests: d._count.requests,
      })),
    },
    recentActivity: {
      recentActions: recentActions.map(toAction),
      recentSignups: recentSignups.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        role: s.role,
        createdAt: s.createdAt.toISOString(),
      })),
      recentReports: recentReports.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        reason: r.reason,
        reporter: r.reporter.name,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    // Backwards compatibility with earlier Phase 1 shape
    users: { byRole: count(byRole, "role"), byStatus: count(byStatus, "status"), signedUpLast7Days: new7, signedUpLast30Days: new30 },
    players: { profiles, hiddenByAdmin: hiddenProfiles },
    sportProfiles: perSport.map((r) => ({
      sportId: r.sportId,
      code: sportsList.find((s) => s.id === r.sportId)?.code ?? "?",
      nameEn: sportsList.find((s) => s.id === r.sportId)?.nameEn ?? "?",
      count: r._count._all,
    })),
    recruiters: { profiles: recruiters, verified: verifiedRecruiters },
    requests: { byStatus: reqCounts },
    moderation: { openReports, actionsLast24h: actions24h },
  };
}

// ───────────────────────── audit log ─────────────────────────

const toAction = (a: Prisma.AdminActionGetPayload<object>) => ({
  id: a.id,
  adminId: a.adminId,
  action: a.action,
  targetType: a.targetType,
  targetId: a.targetId,
  reason: a.reason,
  metadata: a.metadata,
  createdAt: a.createdAt.toISOString(),
});

export async function listActions(q: z.infer<typeof actionsQuery>) {
  const rows = await prisma.adminAction.findMany({
    where: {
      ...(q.targetType && { targetType: q.targetType }),
      ...(q.targetId && { targetId: q.targetId }),
      ...(q.adminId && { adminId: q.adminId }),
      ...(q.action && { action: q.action as AdminActionType }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toAction), nextCursor };
}

// ───────────────────────── app config ─────────────────────────

export const getConfig = readAll;

export async function setConfig(adminId: string, key: ConfigKey, value: unknown) {
  const parsed = CONFIG_SCHEMAS[key].safeParse(value);
  if (!parsed.success) throw AppError.invalid("value", parsed.error.issues[0]?.message ?? `Invalid value for ${key}`);

  const before = (await readAll())[key];
  await prisma.$transaction(async (tx) => {
    await tx.appConfig.upsert({ where: { key }, update: { value: parsed.data }, create: { key, value: parsed.data } });
    await audit(tx, adminId, "CONFIG_SET", "CONFIG", key, null, { from: before as Prisma.InputJsonValue, to: parsed.data });
  });
  clearConfigCache();
  return readAll();
}
