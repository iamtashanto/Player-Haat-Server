import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { assertValidLocation, locationInclude } from "../locations/location.service.js";
import { notify } from "../notifications/notifier.js";
import { MAX_DAYS_AHEAD } from "../requests/requests.schema.js";
import { drawBracket, roundCount, bracketSize } from "./bracket.js";
import { MAX_ACTIVE_PER_ORGANISER, type createTournamentBody, type scoreBody, type tournamentsQuery } from "./tournaments.schema.js";

const MIN_TEAMS = 4;
const DAY_MS = 86_400_000;
type Tx = Prisma.TransactionClient;

const include = {
  sport: { select: { id: true, code: true, nameBn: true, nameEn: true } },
  district: locationInclude.district,
  upazila: locationInclude.upazila,
  createdBy: { select: { name: true, status: true } },
  teams: { orderBy: { registeredAt: "asc" }, include: { team: { select: { id: true, name: true, logoUrl: true, captainId: true } } } },
  matches: { orderBy: [{ round: "asc" }, { slot: "asc" }] },
} satisfies Prisma.TournamentInclude;
type Row = Prisma.TournamentGetPayload<{ include: typeof include }>;

async function present(t: Row, viewerId: string | null) {
  const teamById = new Map(t.teams.map((e) => [e.team.id, { id: e.team.id, name: e.team.name, logoUrl: e.team.logoUrl }]));
  // a team that left after the draw can't happen (leaving is blocked once started), so every team in a match is in the map
  const lite = (id: string | null) => (id ? (teamById.get(id) ?? null) : null);
  const rounds = t.matches.length ? Math.max(...t.matches.map((m) => m.round)) : 0;
  const mine = viewerId
    ? await prisma.team.findMany({ where: { captainId: viewerId, sportId: t.sportId }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    sport: t.sport,
    location: { district: t.district, upazila: t.upazila },
    venueText: t.venueText,
    startsAt: t.startsAt.toISOString(),
    maxTeams: t.maxTeams,
    teamCount: t.teams.length,
    organiser: { name: t.createdBy.name },
    champion: lite(t.championTeamId),
    isOwner: viewerId !== null && t.createdById === viewerId,
    teams: [...teamById.values()],
    rounds,
    matches: t.matches.map((m) => ({
      id: m.id,
      round: m.round,
      slot: m.slot,
      home: lite(m.homeTeamId),
      away: lite(m.awayTeamId),
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      winnerTeamId: m.winnerTeamId,
      isBye: m.round === 1 && !!m.homeTeamId !== !!m.awayTeamId,
    })),
    myTeams: mine.map((m) => ({ id: m.id, name: m.name, registered: teamById.has(m.id) })),
  };
}

const load = async (id: string) => {
  const t = await prisma.tournament.findUnique({ where: { id }, include });
  if (!t) throw AppError.notFound("TOURNAMENT_NOT_FOUND", "Tournament not found");
  return t;
};
async function loadOwned(userId: string, id: string) {
  const t = await load(id);
  if (t.createdById !== userId) throw AppError.forbidden("TOURNAMENT_NOT_OWNER", "Only the organiser can do that");
  return t;
}
/** Hidden from everyone but the organiser when the organiser is suspended. */
const visible = (t: Row, viewerId: string | null) => t.createdBy.status === "ACTIVE" || t.createdById === viewerId;

export async function create(userId: string, input: z.infer<typeof createTournamentBody>) {
  if (!(await prisma.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } }))) throw AppError.invalid("sportId", "Unknown or inactive sport");
  await assertValidLocation(input);
  const at = new Date(input.startsAt);
  if (at.getTime() <= Date.now()) throw AppError.invalid("startsAt", "Pick a time in the future");
  if (at.getTime() > Date.now() + MAX_DAYS_AHEAD * DAY_MS) throw AppError.invalid("startsAt", `At most ${MAX_DAYS_AHEAD} days ahead`);
  const active = await prisma.tournament.count({ where: { createdById: userId, status: { in: ["REGISTRATION", "RUNNING"] } } });
  if (active >= MAX_ACTIVE_PER_ORGANISER) throw AppError.conflict("TOURNAMENT_LIMIT", `You can run at most ${MAX_ACTIVE_PER_ORGANISER} tournaments at once`);
  const t = await prisma.tournament.create({
    data: { createdById: userId, name: input.name, sportId: input.sportId, districtId: input.districtId, upazilaId: input.upazilaId, venueText: input.venueText ?? null, startsAt: at, maxTeams: input.maxTeams },
    include,
  });
  return present(t, userId);
}

export async function list(viewerId: string | null, q: z.infer<typeof tournamentsQuery>) {
  const rows = await prisma.tournament.findMany({
    where: {
      status: q.status ?? { in: ["REGISTRATION", "RUNNING", "FINISHED"] },
      createdBy: { status: "ACTIVE" },
      ...(q.sportId && { sportId: q.sportId }),
      ...(q.upazilaId && { upazilaId: q.upazilaId }),
      ...(q.districtId && { districtId: q.districtId }),
    },
    include,
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: await Promise.all(items.map((t) => present(t, viewerId))), nextCursor };
}

export async function get(viewerId: string | null, id: string) {
  const t = await load(id);
  if (!visible(t, viewerId)) throw AppError.notFound("TOURNAMENT_NOT_FOUND", "Tournament not found");
  return present(t, viewerId);
}

export async function registerTeam(userId: string, id: string, teamId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.tournament.findUnique({ where: { id }, include: { teams: { select: { teamId: true } } } });
    if (!t) throw AppError.notFound("TOURNAMENT_NOT_FOUND", "Tournament not found");
    if (t.status !== "REGISTRATION") throw AppError.conflict("TOURNAMENT_NOT_OPEN", "Registration is closed");
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { captainId: true, sportId: true } });
    if (!team || team.captainId !== userId) throw AppError.invalid("teamId", "You can only enter a team you captain");
    if (team.sportId !== t.sportId) throw AppError.invalid("teamId", "Your team plays a different sport");
    if (t.teams.some((e) => e.teamId === teamId)) throw AppError.conflict("TOURNAMENT_ALREADY_IN", "This team is already entered");
    if (t.teams.length >= t.maxTeams) throw AppError.conflict("TOURNAMENT_FULL", "The tournament is full");
    await tx.tournamentTeam.create({ data: { tournamentId: id, teamId } });
  });
  return get(userId, id);
}

export async function removeTeam(userId: string, id: string, teamId: string) {
  const t = await load(id);
  const entry = t.teams.find((e) => e.teamId === teamId);
  if (!entry) throw AppError.notFound("TOURNAMENT_ENTRY_NOT_FOUND", "That team is not entered");
  if (entry.team.captainId !== userId && t.createdById !== userId) throw AppError.forbidden("TOURNAMENT_NOT_ALLOWED", "Only the team's captain or the organiser can do that");
  if (t.status !== "REGISTRATION") throw AppError.conflict("TOURNAMENT_NOT_OPEN", "The tournament has started");
  await prisma.tournamentTeam.delete({ where: { tournamentId_teamId: { tournamentId: id, teamId } } });
  return get(userId, id);
}

/** Moves a decided match's winner into its place in the next round, or crowns the champion after the final. */
async function advance(tx: Tx, tournamentId: string, round: number, slot: number, winnerId: string, rounds: number) {
  if (round >= rounds) {
    await tx.tournament.update({ where: { id: tournamentId }, data: { status: "FINISHED", championTeamId: winnerId } });
    return;
  }
  await tx.tournamentMatch.update({
    where: { tournamentId_round_slot: { tournamentId, round: round + 1, slot: Math.floor(slot / 2) } },
    data: slot % 2 === 0 ? { homeTeamId: winnerId } : { awayTeamId: winnerId },
  });
}

export async function start(userId: string, id: string) {
  const t = await loadOwned(userId, id);
  if (t.status !== "REGISTRATION") throw AppError.conflict("TOURNAMENT_NOT_OPEN", "This tournament has already started or was cancelled");
  if (t.teams.length < MIN_TEAMS) throw AppError.conflict("TOURNAMENT_TOO_FEW", `At least ${MIN_TEAMS} teams are needed to start`);
  const slots = drawBracket(t.teams.map((e) => e.teamId));
  const rounds = roundCount(bracketSize(t.teams.length));
  await prisma.$transaction(async (tx) => {
    await tx.tournament.update({ where: { id }, data: { status: "RUNNING" } });
    await tx.tournamentMatch.createMany({ data: slots.map((s) => ({ tournamentId: id, round: s.round, slot: s.slot, homeTeamId: s.home, awayTeamId: s.away })) });
    // a team with no opponent moves straight on
    for (const s of slots.filter((x) => x.round === 1 && !!x.home !== !!x.away)) {
      const winner = (s.home ?? s.away)!;
      await tx.tournamentMatch.update({ where: { tournamentId_round_slot: { tournamentId: id, round: 1, slot: s.slot } }, data: { winnerTeamId: winner } });
      await advance(tx, id, 1, s.slot, winner, rounds);
    }
  });
  notify({
    userIds: t.teams.map((e) => e.team.captainId),
    type: "SYSTEM",
    data: { code: "TOURNAMENT_STARTED", tournamentId: id },
    params: { code: "TOURNAMENT_STARTED", heading: t.name },
  });
  return get(userId, id);
}

export async function enterScore(userId: string, id: string, matchId: string, input: z.infer<typeof scoreBody>) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.tournament.findUnique({ where: { id }, select: { createdById: true, status: true, matches: { select: { id: true, round: true, slot: true, homeTeamId: true, awayTeamId: true, homeScore: true, winnerTeamId: true } } } });
    if (!t) throw AppError.notFound("TOURNAMENT_NOT_FOUND", "Tournament not found");
    if (t.createdById !== userId) throw AppError.forbidden("TOURNAMENT_NOT_OWNER", "Only the organiser can do that");
    if (t.status !== "RUNNING" && t.status !== "FINISHED") throw AppError.conflict("TOURNAMENT_NOT_RUNNING", "The tournament has not started");
    const m = t.matches.find((x) => x.id === matchId);
    if (!m) throw AppError.notFound("TOURNAMENT_MATCH_NOT_FOUND", "Match not found");
    if (!m.homeTeamId || !m.awayTeamId) throw AppError.conflict("TOURNAMENT_MATCH_NOT_READY", "Both teams must be known first");
    const level = input.homeScore === input.awayScore;
    if (level && !input.winner) throw AppError.invalid("winner", "A knockout match needs a winner: say who won on penalties");
    const winner = level ? (input.winner === "HOME" ? m.homeTeamId : m.awayTeamId) : input.homeScore > input.awayScore ? m.homeTeamId : m.awayTeamId;
    if (!level && input.winner && winner !== (input.winner === "HOME" ? m.homeTeamId : m.awayTeamId)) throw AppError.invalid("winner", "The winner must be the team with more goals");
    const rounds = Math.max(...t.matches.map((x) => x.round));
    // a correction is allowed only while the next match has not been played
    if (m.winnerTeamId && m.round < rounds) {
      const next = t.matches.find((x) => x.round === m.round + 1 && x.slot === Math.floor(m.slot / 2));
      if (next?.winnerTeamId) throw AppError.conflict("TOURNAMENT_MATCH_LOCKED", "The next match was already played");
    }
    await tx.tournamentMatch.update({ where: { id: matchId }, data: { homeScore: input.homeScore, awayScore: input.awayScore, winnerTeamId: winner, playedAt: new Date() } });
    if (m.winnerTeamId && m.winnerTeamId !== winner && m.round >= rounds) await tx.tournament.update({ where: { id }, data: { status: "RUNNING", championTeamId: null } });
    await advance(tx, id, m.round, m.slot, winner, rounds);
  });
  return get(userId, id);
}

export async function cancel(userId: string, id: string) {
  const t = await loadOwned(userId, id);
  if (t.status === "FINISHED") throw AppError.conflict("TOURNAMENT_NOT_OPEN", "This tournament is finished");
  if (t.status !== "CANCELLED") await prisma.tournament.update({ where: { id }, data: { status: "CANCELLED" } });
  return get(userId, id);
}
