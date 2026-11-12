import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifier.js";
import { MAX_DAYS_AHEAD } from "../requests/requests.schema.js";
import type { acceptBody, challengeBody, challengesQuery } from "./competition.schema.js";

const MAX_OPEN_PER_TEAM = 3;
const DAY_MS = 86_400_000;

const include = {
  team: { select: { id: true, name: true, logoUrl: true, captainId: true, district: { select: { id: true, nameBn: true, nameEn: true } }, upazila: { select: { id: true, nameBn: true, nameEn: true } }, sport: { select: { id: true, code: true, nameBn: true, nameEn: true } } } },
  acceptedBy: { select: { id: true, name: true } },
} as const;

type Row = Awaited<ReturnType<typeof load>>;
const load = async (id: string) => {
  const c = await prisma.teamChallenge.findUnique({ where: { id }, include });
  if (!c) throw AppError.notFound("CHALLENGE_NOT_FOUND", "Challenge not found");
  return c;
};

function present(c: Row, viewerId: string) {
  return {
    id: c.id,
    status: c.status,
    team: { id: c.team.id, name: c.team.name, logoUrl: c.team.logoUrl, district: c.team.district, upazila: c.team.upazila },
    sport: c.team.sport,
    venueText: c.venueText,
    proposedAt: c.proposedAt.toISOString(),
    notes: c.notes,
    isMine: c.team.captainId === viewerId,
    acceptedBy: c.acceptedBy ? { id: c.acceptedBy.id, name: c.acceptedBy.name } : null,
    requestId: c.requestId,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function create(userId: string, input: z.infer<typeof challengeBody>) {
  const team = await prisma.team.findUnique({ where: { id: input.teamId }, select: { id: true, captainId: true, sportId: true, districtId: true, upazilaId: true } });
  if (!team || team.captainId !== userId) throw AppError.invalid("teamId", "You can only challenge for a team you captain");
  const at = new Date(input.proposedAt);
  if (at.getTime() <= Date.now()) throw AppError.invalid("proposedAt", "Pick a time in the future");
  if (at.getTime() > Date.now() + MAX_DAYS_AHEAD * DAY_MS) throw AppError.invalid("proposedAt", `At most ${MAX_DAYS_AHEAD} days ahead`);
  const open = await prisma.teamChallenge.count({ where: { teamId: team.id, status: "OPEN", proposedAt: { gt: new Date() } } });
  if (open >= MAX_OPEN_PER_TEAM) throw AppError.conflict("CHALLENGE_LIMIT", `A team can have at most ${MAX_OPEN_PER_TEAM} open challenges`);
  const c = await prisma.teamChallenge.create({
    data: { teamId: team.id, createdById: userId, sportId: team.sportId, districtId: team.districtId, upazilaId: team.upazilaId, venueText: input.venueText, proposedAt: at, notes: input.notes ?? null },
    include,
  });
  return present(c, userId);
}

/** Open challenges that are still in the future, soonest first. Mine are included (flagged) so a captain sees them in the list too. */
export async function list(userId: string, q: z.infer<typeof challengesQuery>) {
  const rows = await prisma.teamChallenge.findMany({
    where: { status: "OPEN", proposedAt: { gt: new Date() }, team: { captain: { status: "ACTIVE" } }, ...(q.sportId && { sportId: q.sportId }), ...(q.upazilaId && { upazilaId: q.upazilaId }), ...(q.districtId && { districtId: q.districtId }) },
    include,
    orderBy: [{ proposedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  return rows.map((c) => present(c, userId));
}

export async function mine(userId: string) {
  const rows = await prisma.teamChallenge.findMany({ where: { OR: [{ team: { captainId: userId } }, { acceptedBy: { captainId: userId } }] }, include, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((c) => present(c, userId));
}

/** The other captain accepts: a match is created for the challenger's team with the accepting team as its opponent. */
export async function accept(userId: string, id: string, input: z.infer<typeof acceptBody>) {
  const { challenge, request } = await prisma.$transaction(async (tx) => {
    // lock the challenge so two captains can't both accept it
    await tx.$queryRaw`SELECT id FROM "TeamChallenge" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.teamChallenge.findUnique({ where: { id }, include });
    if (!c) throw AppError.notFound("CHALLENGE_NOT_FOUND", "Challenge not found");
    if (c.status !== "OPEN") throw AppError.conflict("CHALLENGE_NOT_OPEN", `This challenge is ${c.status.toLowerCase()}`);
    if (c.proposedAt.getTime() <= Date.now()) throw AppError.conflict("CHALLENGE_EXPIRED", "The proposed time has passed");
    if (c.team.captainId === userId) throw AppError.forbidden("CHALLENGE_OWN", "You can't accept your own challenge");
    const mine = await tx.team.findUnique({ where: { id: input.teamId }, select: { id: true, name: true, captainId: true, sportId: true } });
    if (!mine || mine.captainId !== userId) throw AppError.invalid("teamId", "You can only accept for a team you captain");
    if (mine.sportId !== c.sportId) throw AppError.invalid("teamId", "Your team plays a different sport");
    const request = await tx.playerRequest.create({
      data: {
        createdById: c.team.captainId,
        teamId: c.teamId,
        opponentTeamId: mine.id,
        sportId: c.sportId,
        matchAt: c.proposedAt,
        venueText: c.venueText,
        districtId: c.districtId,
        upazilaId: c.upazilaId,
        positionsNeeded: [],
        playersNeeded: 1,
        notes: [`${c.team.name} vs ${mine.name}`, c.notes].filter(Boolean).join(" · ").slice(0, 500),
        kind: "MATCH",
      },
    });
    const updated = await tx.teamChallenge.update({ where: { id }, data: { status: "ACCEPTED", acceptedByTeamId: mine.id, requestId: request.id }, include });
    return { challenge: updated, request };
  });
  notify({
    userIds: [challenge.team.captainId],
    type: "SYSTEM",
    data: { requestId: request.id, code: "CHALLENGE_ACCEPTED" },
    params: { code: "CHALLENGE_ACCEPTED", venue: challenge.venueText, when: challenge.proposedAt },
  });
  return present(challenge, userId);
}

export async function cancel(userId: string, id: string) {
  const c = await load(id);
  if (c.team.captainId !== userId) throw AppError.forbidden("CHALLENGE_NOT_OWNER", "Only the challenging captain can cancel");
  if (c.status === "ACCEPTED") throw AppError.conflict("CHALLENGE_NOT_OPEN", "This challenge was accepted; cancel the match instead");
  if (c.status === "CANCELLED") return present(c, userId);
  return present(await prisma.teamChallenge.update({ where: { id }, data: { status: "CANCELLED" }, include }), userId);
}
