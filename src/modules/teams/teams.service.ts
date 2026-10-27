import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { storage } from "../../lib/storage/index.js";
import { isOwnedBy } from "../../lib/storage/paths.js";
import { assertValidLocation, locationInclude } from "../locations/location.service.js";
import { notify } from "../notifications/notifier.js";
import { MAX_TEAMS_PER_CAPTAIN, MAX_TEAM_MEMBERS, type createTeamBody, type joinBody, type updateTeamBody } from "./teams.schema.js";

const include = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  ...locationInclude,
  captain: { select: { name: true, avatarUrl: true, playerProfile: { select: { id: true } }, recruiterProfile: { select: { id: true } } } },
  members: {
    orderBy: [{ joinedAt: "asc" }],
    include: { user: { select: { name: true, avatarUrl: true, status: true, playerProfile: { select: { id: true } } } } },
  },
} satisfies Prisma.TeamInclude;
type Row = Prisma.TeamGetPayload<{ include: typeof include }>;

const newCode = () => randomBytes(4).toString("hex").toUpperCase(); // 8 chars, 32 bits; joins are rate-limited

function present(t: Row, viewerId: string, detailed: boolean) {
  const isCaptain = t.captainId === viewerId;
  const active = t.members.filter((m) => m.user.status === "ACTIVE");
  return {
    id: t.id,
    name: t.name,
    logoUrl: t.logoUrl,
    sport: t.sport,
    location: { district: t.district, upazila: t.upazila, union: t.union },
    memberCount: active.length,
    captain: { name: t.captain.name, avatarUrl: t.captain.avatarUrl, profileId: t.captain.playerProfile?.id ?? null, recruiterId: t.captain.recruiterProfile?.id ?? null },
    isCaptain,
    isMember: t.members.some((m) => m.userId === viewerId),
    ...(isCaptain && { joinCode: t.joinCode }), // only the captain can hand it out
    ...(detailed && { members: active.map((m) => ({ memberId: m.id, name: m.user.name, avatarUrl: m.user.avatarUrl, role: m.role, profileId: m.user.playerProfile?.id ?? null })) }),
  };
}

const load = async (id: string) => {
  const t = await prisma.team.findUnique({ where: { id }, include });
  if (!t) throw AppError.notFound("TEAM_NOT_FOUND", "Team not found");
  return t;
};
async function loadAsCaptain(userId: string, id: string) {
  const t = await load(id);
  if (t.captainId !== userId) throw AppError.forbidden("TEAM_NOT_CAPTAIN", "Only the captain can do that");
  return t;
}

export async function create(userId: string, input: z.infer<typeof createTeamBody>) {
  if (!(await prisma.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } }))) throw AppError.invalid("sportId", "Unknown or inactive sport");
  await assertValidLocation(input);
  if ((await prisma.team.count({ where: { captainId: userId } })) >= MAX_TEAMS_PER_CAPTAIN) {
    throw AppError.conflict("TEAM_LIMIT", `You can captain up to ${MAX_TEAMS_PER_CAPTAIN} teams`);
  }
  const t = await prisma.team.create({
    data: { name: input.name, sportId: input.sportId, districtId: input.districtId, upazilaId: input.upazilaId, unionId: input.unionId ?? null, captainId: userId, members: { create: { userId, role: "CAPTAIN" } } },
    include,
  });
  return present(t, userId, true);
}

export async function mine(userId: string) {
  const rows = await prisma.team.findMany({ where: { OR: [{ captainId: userId }, { members: { some: { userId } } }] }, include, orderBy: { createdAt: "desc" } });
  return rows.map((t) => present(t, userId, false));
}

export async function get(userId: string, id: string) {
  return present(await load(id), userId, true);
}

export async function update(userId: string, id: string, patch: z.infer<typeof updateTeamBody>) {
  const t = await loadAsCaptain(userId, id);
  const districtId = patch.districtId ?? t.districtId;
  const upazilaId = patch.upazilaId ?? t.upazilaId;
  const unionId = patch.unionId !== undefined ? patch.unionId : patch.upazilaId !== undefined ? null : t.unionId;
  if (patch.districtId !== undefined || patch.unionId !== undefined) await assertValidLocation({ districtId, upazilaId, unionId });

  let logo: { logoUrl: string | null; logoPublicId: string | null } | undefined;
  if (patch.logoPublicId !== undefined) {
    if (patch.logoPublicId !== null && (!isOwnedBy(userId, patch.logoPublicId) || !patch.logoPublicId.includes("/team-logos/"))) throw AppError.invalid("logoPublicId", "Upload the logo with type team-logo first");
    logo = patch.logoPublicId === null ? { logoUrl: null, logoPublicId: null } : { logoUrl: storage.urlFor(patch.logoPublicId), logoPublicId: patch.logoPublicId };
  }
  const updated = await prisma.team.update({ where: { id }, data: { ...(patch.name !== undefined && { name: patch.name }), districtId, upazilaId, unionId, ...logo }, include });
  if (logo && t.logoPublicId && t.logoPublicId !== logo.logoPublicId) await deleteImagesQuietly([t.logoPublicId]);
  return present(updated, userId, true);
}

export async function resetCode(userId: string, id: string) {
  await loadAsCaptain(userId, id);
  // A fresh code each call; a clash with another team's is astronomically unlikely, and the unique index would refuse it.
  return present(await prisma.team.update({ where: { id }, data: { joinCode: newCode() }, include }), userId, true);
}

export async function join(userId: string, input: z.infer<typeof joinBody>) {
  const t = await prisma.team.findUnique({ where: { joinCode: input.code }, include });
  if (!t) throw AppError.notFound("TEAM_CODE_INVALID", "No team has that code");
  if (t.members.some((m) => m.userId === userId)) throw AppError.conflict("TEAM_ALREADY_MEMBER", "You're already in this team");
  if (t.members.length >= MAX_TEAM_MEMBERS) throw AppError.conflict("TEAM_FULL", "This team is full");
  try {
    await prisma.teamMember.create({ data: { teamId: t.id, userId, role: "PLAYER" } });
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") throw AppError.conflict("TEAM_ALREADY_MEMBER", "You're already in this team");
    throw err;
  }
  const joiner = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  notify({ userIds: [t.captainId], type: "TEAM_JOINED", data: { teamId: t.id }, params: { actor: `${joiner.name} · ${t.name}` } });
  return present(await load(t.id), userId, true);
}

export async function leave(userId: string, id: string) {
  const t = await load(id);
  if (t.captainId === userId) throw AppError.conflict("TEAM_CAPTAIN_CANNOT_LEAVE", "Delete the team instead — a team needs its captain");
  const { count } = await prisma.teamMember.deleteMany({ where: { teamId: id, userId } });
  if (count === 0) throw AppError.notFound("TEAM_NOT_FOUND", "You're not in that team");
  return { left: true };
}

export async function removeMember(userId: string, id: string, memberId: string) {
  const t = await loadAsCaptain(userId, id);
  const m = t.members.find((x) => x.id === memberId);
  if (!m) throw AppError.notFound("TEAM_MEMBER_NOT_FOUND", "Member not found");
  if (m.userId === userId) throw AppError.conflict("TEAM_CAPTAIN_CANNOT_LEAVE", "You can't remove yourself; delete the team instead");
  await prisma.teamMember.delete({ where: { id: memberId } });
  return present(await load(id), userId, true);
}

export async function remove(userId: string, id: string) {
  const t = await loadAsCaptain(userId, id);
  await prisma.team.delete({ where: { id } }); // members cascade; requests keep going without the team (SetNull)
  await deleteImagesQuietly([t.logoPublicId]);
  return { deleted: true };
}
