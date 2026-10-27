import type { AdminActionType, Prisma, ReportStatus } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { CONFIG_SCHEMAS, clearConfigCache, readAll, type ConfigKey } from "../app-config/app-config.service.js";
import { retireParticipation } from "../moderation/participation.js";
import { notify } from "../notifications/notifier.js";
import { revokeAllForUser } from "../auth/token.service.js";
import type { actionsQuery, playersQuery, recruitersQuery, reportsQuery, usersQuery } from "./admin.schema.js";

type Tx = Prisma.TransactionClient;

/** Written in the same transaction as the change it records, so the log can't disagree with reality. */
const audit = (tx: Tx, adminId: string, action: AdminActionType, targetType: string, targetId: string, reason?: string | null, metadata?: Prisma.InputJsonObject) =>
  tx.adminAction.create({ data: { adminId, action, targetType, targetId, reason: reason ?? null, metadata } });

// ───────────────────────── users ─────────────────────────

const userSelect = {
  id: true, name: true, email: true, phone: true, status: true, role: true, emailVerifiedAt: true, createdAt: true,
  playerProfile: { select: { id: true } },
  recruiterProfile: { select: { id: true, verifiedBadge: true } },
} satisfies Prisma.UserSelect;

const toUserSummary = (u: Prisma.UserGetPayload<{ select: typeof userSelect }>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  role: u.role,
  emailVerified: u.emailVerifiedAt !== null,
  profileId: u.playerProfile?.id ?? null,
  recruiterId: u.recruiterProfile?.id ?? null,
  createdAt: u.createdAt.toISOString(),
});

export async function listUsers(q: z.infer<typeof usersQuery>) {
  const rows = await prisma.user.findMany({
    where: {
      ...(q.status && { status: q.status }),
      ...(q.role && { role: q.role }),
      ...(q.q && {
        OR: [
          { name: { contains: q.q, mode: "insensitive" } },
          { email: { contains: q.q, mode: "insensitive" } },
          { phone: { contains: q.q } },
        ],
      }),
    },
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
    select: {
      ...userSelect,
      captainAvgRating: true,
      captainRatingCount: true,
      playerProfile: { select: { id: true, isVisible: true, hiddenByAdminAt: true, verifiedBadge: true, avgRating: true, ratingCount: true, noShowCount: true } },
      recruiterProfile: { select: { id: true, type: true, organization: true, verifiedBadge: true } },
      _count: { select: { requestsCreated: true, applications: true, ratingsReceived: true, reportsFiled: true } },
    },
  });
  if (!u) throw AppError.notFound("USER_NOT_FOUND", "User not found");
  const reportsAgainst = await prisma.report.count({
    where: { OR: [{ targetType: "USER", targetId: id }, ...(u.playerProfile ? [{ targetType: "PLAYER_PROFILE" as const, targetId: u.playerProfile.id }] : [])] },
  });
  return {
    ...toUserSummary(u),
    captainRating: { average: u.captainAvgRating, count: u.captainRatingCount },
    recruiter: u.recruiterProfile,
    profile: u.playerProfile && { ...u.playerProfile, hiddenByAdmin: u.playerProfile.hiddenByAdminAt !== null, hiddenByAdminAt: undefined },
    counts: { requestsPosted: u._count.requestsCreated, applications: u._count.applications, ratingsReceived: u._count.ratingsReceived, reportsFiled: u._count.reportsFiled, reportsAgainst },
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
  const u = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { id: true, name: true, email: true, role: true } });
  return u;
}

/**
 * Player ⇄ recruiter. Admin is deliberately not reachable from here: those accounts are made and
 * removed with `npm run admin:grant` by someone with shell access.
 */
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
  user: { select: { id: true, name: true, email: true, status: true } },
  district: { select: { nameEn: true } },
  upazila: { select: { nameEn: true } },
  sports: { orderBy: { createdAt: "asc" }, include: { sport: { select: { code: true } }, _count: { select: { achievements: true } } } },
} satisfies Prisma.PlayerProfileInclude;

export async function listPlayers(q: z.infer<typeof playersQuery>) {
  const rows = await prisma.playerProfile.findMany({
    where: {
      ...(q.q && { user: { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }] } }),
      ...(q.sportId && { sports: { some: { sportId: q.sportId } } }),
      ...(q.hidden === true && { OR: [{ hiddenByAdminAt: { not: null } }, { sports: { some: { hiddenByAdminAt: { not: null } } } }] }),
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
      isVisible: p.isVisible,
      hiddenByAdmin: p.hiddenByAdminAt !== null,
      verifiedBadge: p.verifiedBadge,
      rating: { average: Math.round(p.avgRating * 100) / 100, count: p.ratingCount },
      noShowCount: p.noShowCount,
      sportProfiles: p.sports.map((s) => ({
        id: s.id,
        sportId: s.sportId,
        sportCode: s.sport.code,
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
      ...(q.q && {
        OR: [
          { organization: { contains: q.q, mode: "insensitive" } },
          { user: { name: { contains: q.q, mode: "insensitive" } } },
          { user: { email: { contains: q.q, mode: "insensitive" } } },
        ],
      }),
    },
    include: { user: { select: { id: true, name: true, email: true, status: true } }, district: { select: { nameEn: true } } },
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

// ───────────────────────── overview ─────────────────────────

const DAY = 86_400_000;

export async function stats() {
  const now = Date.now();
  const [byRole, byStatus, new7, new30, profiles, hiddenProfiles, perSport, recruiters, verifiedRecruiters, requestsByStatus, openReports, actions24h] = await Promise.all([
    prisma.user.groupBy({ by: ["role"], where: { status: { not: "DELETED" } }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - 7 * DAY) } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - 30 * DAY) } } }),
    prisma.playerProfile.count(),
    prisma.playerProfile.count({ where: { hiddenByAdminAt: { not: null } } }),
    prisma.playerSport.groupBy({ by: ["sportId"], _count: { _all: true } }),
    prisma.recruiterProfile.count(),
    prisma.recruiterProfile.count({ where: { verifiedBadge: true } }),
    prisma.playerRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.report.count({ where: { status: "OPEN" } }),
    prisma.adminAction.count({ where: { createdAt: { gte: new Date(now - DAY) } } }),
  ]);
  const sports = await prisma.sport.findMany({ select: { id: true, code: true, nameEn: true } });
  const count = <K extends string>(rows: Array<Record<K, string> & { _count: { _all: number } }>, key: K) =>
    Object.fromEntries(rows.map((r) => [r[key], r._count._all]));
  return {
    users: { byRole: count(byRole, "role"), byStatus: count(byStatus, "status"), signedUpLast7Days: new7, signedUpLast30Days: new30 },
    players: { profiles, hiddenByAdmin: hiddenProfiles },
    sportProfiles: perSport.map((r) => ({ sportId: r.sportId, code: sports.find((s) => s.id === r.sportId)?.code ?? "?", nameEn: sports.find((s) => s.id === r.sportId)?.nameEn ?? "?", count: r._count._all })),
    recruiters: { profiles: recruiters, verified: verifiedRecruiters },
    requests: { byStatus: count(requestsByStatus, "status") },
    moderation: { openReports, actionsLast24h: actions24h },
  };
}

// ───────────────────────── profiles & requests ─────────────────────────

const profileView = (p: { id: string; isVisible: boolean; hiddenByAdminAt: Date | null; verifiedBadge: boolean }) => ({
  id: p.id,
  isVisible: p.isVisible,
  hiddenByAdmin: p.hiddenByAdminAt !== null,
  verifiedBadge: p.verifiedBadge,
});

async function loadProfile(profileId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { id: profileId }, select: { id: true, isVisible: true, hiddenByAdminAt: true, verifiedBadge: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Profile not found");
  return p;
}

export async function setProfileHidden(adminId: string, profileId: string, hidden: boolean, reason?: string) {
  const p = await loadProfile(profileId);
  if (hidden === (p.hiddenByAdminAt !== null)) {
    throw AppError.conflict(hidden ? "PROFILE_ALREADY_HIDDEN" : "PROFILE_NOT_HIDDEN", hidden ? "Already hidden" : "Not hidden");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerProfile.update({ where: { id: profileId }, data: { hiddenByAdminAt: hidden ? new Date() : null } });
    await audit(tx, adminId, hidden ? "PROFILE_HIDE" : "PROFILE_UNHIDE", "PLAYER_PROFILE", profileId, reason);
    return profileView(updated);
  });
}

export async function setProfileVerified(adminId: string, profileId: string, verified: boolean) {
  const p = await loadProfile(profileId);
  if (p.verifiedBadge === verified) return profileView(p); // nothing to change, nothing to log
  return prisma.$transaction(async (tx) => {
    const updated = await tx.playerProfile.update({ where: { id: profileId }, data: { verifiedBadge: verified } });
    await audit(tx, adminId, verified ? "PROFILE_VERIFY" : "PROFILE_UNVERIFY", "PLAYER_PROFILE", profileId);
    return profileView(updated);
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
    // A triage queue is worked oldest-first; history is read newest-first.
    orderBy: q.status === "OPEN" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  const counts = await Promise.all(items.map((r) => prisma.report.count({ where: { targetType: r.targetType, targetId: r.targetId, status: "OPEN" } })));
  return { items: items.map((r, i) => toReport(r, counts[i])), nextCursor };
}

/** What the report points at, in terms an admin can act on (with the ids the moderation endpoints take). */
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
    // Compare-and-set so two admins can't both "resolve" the same report.
    const { count } = await tx.report.updateMany({
      where: { id, status: "OPEN" },
      data: { status: input.outcome, resolvedById: adminId, resolvedAt: new Date(), resolution: input.resolution },
    });
    if (count === 0) throw AppError.conflict("REPORT_ALREADY_RESOLVED", "Someone else just handled this report");
    await audit(tx, adminId, input.outcome === "RESOLVED" ? "REPORT_RESOLVE" : "REPORT_DISMISS", "REPORT", id, input.resolution);
  });
  return getReport(id);
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
    where: { ...(q.targetType && { targetType: q.targetType }), ...(q.targetId && { targetId: q.targetId }), ...(q.adminId && { adminId: q.adminId }) },
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
