import type { Invite, Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifier.js";
import { DECLINE_COOLDOWN_DAYS, MAX_INVITES_PER_DAY, type createInviteBody, type invitesQuery } from "./invites.schema.js";

const DAY_MS = 86_400_000;

const include = {
  recruiter: { select: { name: true, avatarUrl: true, phone: true, recruiterProfile: { select: { id: true, organization: true, type: true, verifiedBadge: true } } } },
  profile: { select: { id: true, user: { select: { id: true, name: true, avatarUrl: true, phone: true } } } },
  request: { select: { id: true, kind: true, title: true, matchAt: true, venueText: true, sport: { select: { id: true, code: true, nameBn: true, nameEn: true } } } },
} satisfies Prisma.InviteInclude;
type Row = Prisma.InviteGetPayload<{ include: typeof include }>;

async function sportOf(row: Invite, request: Row["request"]) {
  if (row.sportId === null) return request?.sport ?? null;
  return prisma.sport.findUnique({ where: { id: row.sportId }, select: { id: true, code: true, nameBn: true, nameEn: true } });
}

async function present(row: Row, side: "recruiter" | "player") {
  const accepted = row.status === "ACCEPTED";
  const r = row.recruiter;
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    sport: await sportOf(row, row.request),
    request: row.request && { id: row.request.id, kind: row.request.kind, title: row.request.title, matchAt: row.request.matchAt.toISOString(), venueText: row.request.venueText },
    // Each side sees who the other is; the number appears only after the player says yes.
    ...(side === "player"
      ? { recruiter: { name: r.name, avatarUrl: r.avatarUrl, recruiterId: r.recruiterProfile?.id ?? null, organization: r.recruiterProfile?.organization ?? null, type: r.recruiterProfile?.type ?? null, verified: r.recruiterProfile?.verifiedBadge ?? false }, ...(accepted && { contact: { phone: r.phone } }) }
      : { player: { profileId: row.profile.id, name: row.profile.user.name, avatarUrl: row.profile.user.avatarUrl }, ...(accepted && { contact: { phone: row.profile.user.phone } }) }),
  };
}

const display = (r: Row["request"], sport: { nameBn: string; nameEn: string } | null) => ({
  ...(sport && { sport: { bn: sport.nameBn, en: sport.nameEn } }),
  ...(r && { venue: r.venueText, when: r.matchAt }),
});

export async function createInvite(recruiterId: string, input: z.infer<typeof createInviteBody>) {
  const target = await prisma.playerProfile.findFirst({
    where: { id: input.profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" } },
    select: { id: true, userId: true, sports: { where: { isVisible: true, hiddenByAdminAt: null }, select: { sportId: true } } },
  });
  if (!target) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player not found");

  let sportId = input.sportId ?? null;
  let request: Awaited<ReturnType<typeof loadOwnRequest>> = null;
  if (input.requestId) {
    request = await loadOwnRequest(recruiterId, input.requestId);
    if (!request) throw AppError.invalid("requestId", "Pick one of your own upcoming events or requests");
    sportId ??= request.sportId;
  }
  if (sportId !== null && !target.sports.some((s) => s.sportId === sportId)) throw AppError.invalid("sportId", "This player has no public profile for that sport");

  const [pending, declined, today] = await Promise.all([
    prisma.invite.findFirst({ where: { recruiterId, profileId: target.id, status: "PENDING" }, select: { id: true } }),
    prisma.invite.findFirst({ where: { recruiterId, profileId: target.id, status: "DECLINED", respondedAt: { gte: new Date(Date.now() - DECLINE_COOLDOWN_DAYS * DAY_MS) } }, select: { id: true } }),
    prisma.invite.count({ where: { recruiterId, createdAt: { gte: new Date(Date.now() - DAY_MS) } } }),
  ]);
  if (pending) throw AppError.conflict("INVITE_ALREADY_PENDING", "You've already invited this player; wait for their answer");
  if (declined) throw AppError.conflict("INVITE_COOLDOWN", `This player declined recently; try again after ${DECLINE_COOLDOWN_DAYS} days`);
  if (today >= MAX_INVITES_PER_DAY) throw new AppError("INVITE_LIMIT", 429, `You can send up to ${MAX_INVITES_PER_DAY} invitations a day`);

  let row: Row;
  try {
    row = await prisma.invite.create({ data: { recruiterId, profileId: target.id, sportId, requestId: request?.id ?? null, message: input.message ?? null }, include });
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") throw AppError.conflict("INVITE_ALREADY_PENDING", "You've already invited this player; wait for their answer");
    throw err;
  }
  const sport = await sportOf(row, row.request);
  const org = row.recruiter.recruiterProfile?.organization;
  notify({ userIds: [target.userId], type: "INVITE_RECEIVED", data: { inviteId: row.id }, params: { actor: org ? `${row.recruiter.name} · ${org}` : row.recruiter.name, ...display(row.request, sport) } });
  return present(row, "recruiter");
}

const loadOwnRequest = (userId: string, requestId: string) =>
  prisma.playerRequest.findFirst({ where: { id: requestId, createdById: userId, status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: new Date() } }, select: { id: true, sportId: true } });

async function page(where: Prisma.InviteWhereInput, q: z.infer<typeof invitesQuery>, side: "recruiter" | "player") {
  const rows = await prisma.invite.findMany({
    where: { ...where, ...(q.status && { status: q.status }) },
    include,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: await Promise.all(items.map((r) => present(r, side))), nextCursor };
}

export const listSent = (recruiterId: string, q: z.infer<typeof invitesQuery>) => page({ recruiterId }, q, "recruiter");
export const listReceived = (userId: string, q: z.infer<typeof invitesQuery>) => page({ profile: { userId } }, q, "player");

/** Compare-and-set so a double tap (or two devices) can't answer the same invite twice. */
async function transition(id: string, who: { recruiterId?: string; playerUserId?: string }, from: "PENDING", to: "ACCEPTED" | "DECLINED" | "WITHDRAWN") {
  const existing = await prisma.invite.findFirst({
    where: { id, ...(who.recruiterId && { recruiterId: who.recruiterId }), ...(who.playerUserId && { profile: { userId: who.playerUserId } }) },
    select: { id: true, status: true },
  });
  if (!existing) throw AppError.notFound("INVITE_NOT_FOUND", "Invitation not found");
  if (existing.status !== from) throw AppError.conflict("INVITE_NOT_PENDING", `This invitation is already ${existing.status.toLowerCase()}`);
  const { count } = await prisma.invite.updateMany({ where: { id, status: from }, data: { status: to, respondedAt: new Date() } });
  if (count === 0) throw AppError.conflict("INVITE_NOT_PENDING", "This invitation was just answered");
  return prisma.invite.findUniqueOrThrow({ where: { id }, include });
}

export async function acceptInvite(userId: string, id: string) {
  const row = await transition(id, { playerUserId: userId }, "PENDING", "ACCEPTED");
  notify({ userIds: [row.recruiterId], type: "INVITE_ACCEPTED", data: { inviteId: id, profileId: row.profile.id }, params: { actor: row.profile.user.name, ...display(row.request, await sportOf(row, row.request)) } });
  return present(row, "player");
}

export async function declineInvite(userId: string, id: string) {
  const row = await transition(id, { playerUserId: userId }, "PENDING", "DECLINED");
  notify({ userIds: [row.recruiterId], type: "INVITE_DECLINED", data: { inviteId: id }, params: { actor: row.profile.user.name } });
  return present(row, "player");
}

export async function withdrawInvite(recruiterId: string, id: string) {
  return present(await transition(id, { recruiterId }, "PENDING", "WITHDRAWN"), "recruiter");
}
