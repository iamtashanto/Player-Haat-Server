import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { imageUrl } from "../players/players.presenter.js";

/**
 * Standings, from confirmed results only: a score counts once the opponent team's captain confirmed it, so a team can't
 * award itself wins. 3 points for a win, 1 for a draw. A season is a calendar quarter in Dhaka.
 */
const OFFSET_MS = 6 * 3_600_000;

export type Period = "season" | "all";

export function seasonOf(now = new Date()) {
  const local = new Date(now.getTime() + OFFSET_MS);
  const q = Math.floor(local.getUTCMonth() / 3);
  const from = new Date(Date.UTC(local.getUTCFullYear(), q * 3, 1) - OFFSET_MS);
  const to = new Date(Date.UTC(local.getUTCFullYear(), q * 3 + 3, 1) - OFFSET_MS);
  return { from, to, year: local.getUTCFullYear(), quarter: q + 1 };
}

const range = (period: Period, now: Date) => {
  if (period === "all") return { from: undefined, to: undefined, label: null as null | { year: number; quarter: number } };
  const s = seasonOf(now);
  return { from: s.from, to: s.to, label: { year: s.year, quarter: s.quarter } };
};

interface Line { played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number }
const empty = (): Line => ({ played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 });
function add(l: Line, gf: number, ga: number) {
  l.played++;
  l.gf += gf;
  l.ga += ga;
  if (gf > ga) { l.won++; l.points += 3; } else if (gf === ga) { l.drawn++; l.points += 1; } else l.lost++;
}

const teamSelect = { id: true, name: true, logoUrl: true, logoPublicId: true, sportId: true, districtId: true, upazilaId: true, district: { select: { id: true, nameBn: true, nameEn: true } }, upazila: { select: { id: true, nameBn: true, nameEn: true } } } satisfies Prisma.TeamSelect;
type TeamRow = Prisma.TeamGetPayload<{ select: typeof teamSelect }>;

const confirmedWhere = (extra: Prisma.MatchResultWhereInput = {}): Prisma.MatchResultWhereInput => ({
  opponentConfirmedAt: { not: null },
  opponentTeamId: { not: null },
  request: { teamId: { not: null }, status: { not: "CANCELLED" } },
  ...extra,
});

async function confirmedResults(opts: { sportId?: number; from?: Date; to?: Date; teamId?: string }) {
  const matchAt = opts.from ? { gte: opts.from, lt: opts.to } : undefined;
  return prisma.matchResult.findMany({
    where: confirmedWhere({
      request: { teamId: { not: null }, status: { not: "CANCELLED" }, ...(opts.sportId && { sportId: opts.sportId }), ...(matchAt && { matchAt }) },
      ...(opts.teamId && { OR: [{ opponentTeamId: opts.teamId }, { request: { teamId: opts.teamId } }] }),
    }),
    select: {
      ourScore: true,
      theirScore: true,
      opponentTeamId: true,
      request: { select: { id: true, matchAt: true, venueText: true, teamId: true, team: { select: teamSelect } } },
      opponentTeam: { select: teamSelect },
    },
    orderBy: { request: { matchAt: "desc" } },
    take: 5000,
  });
}

const teamOut = (t: TeamRow) => ({ id: t.id, name: t.name, logoUrl: imageUrl(t.logoPublicId, t.logoUrl), district: t.district, upazila: t.upazila });

export async function teamStandings(q: { sportId: number; upazilaId?: number; districtId?: number; period: Period }, now = new Date()) {
  const { from, to, label } = range(q.period, now);
  const results = await confirmedResults({ sportId: q.sportId, from, to });
  const lines = new Map<string, { team: TeamRow; line: Line }>();
  const touch = (t: TeamRow | null) => {
    if (!t) return null;
    let e = lines.get(t.id);
    if (!e) lines.set(t.id, (e = { team: t, line: empty() }));
    return e.line;
  };
  for (const r of results) {
    const home = r.request.team;
    const away = r.opponentTeam;
    if (!home || !away) continue;
    const a = touch(home);
    const b = touch(away);
    if (a) add(a, r.ourScore, r.theirScore);
    if (b) add(b, r.theirScore, r.ourScore);
  }
  const rows = [...lines.values()]
    .filter((e) => (q.upazilaId ? e.team.upazilaId === q.upazilaId : q.districtId ? e.team.districtId === q.districtId : true))
    .sort((x, y) => y.line.points - x.line.points || y.line.gf - y.line.ga - (x.line.gf - x.line.ga) || y.line.gf - x.line.gf || x.team.name.localeCompare(y.team.name))
    .slice(0, 50)
    .map((e, i) => ({ rank: i + 1, team: teamOut(e.team), ...e.line, goalDiff: e.line.gf - e.line.ga }));
  return { season: label, teams: rows };
}

/** Most games played (attendance marked by the organiser) in the area: local pride, and only for people who chose to be visible. */
export async function playerLeaderboard(q: { sportId: number; upazilaId?: number; districtId?: number; period: Period }, now = new Date()) {
  const { from, to } = range(q.period, now);
  const where: Prisma.ApplicationWhereInput = {
    attendance: "ATTENDED",
    status: "ACCEPTED",
    request: { kind: "MATCH", sportId: q.sportId, status: { not: "CANCELLED" }, ...(from && { matchAt: { gte: from, lt: to } }) },
    player: { status: "ACTIVE", playerProfile: { is: { isVisible: true, hiddenByAdminAt: null, ...(q.upazilaId ? { upazilaId: q.upazilaId } : q.districtId ? { districtId: q.districtId } : {}) } } },
  };
  const grouped = await prisma.application.groupBy({ by: ["playerId"], where, _count: { _all: true }, orderBy: { _count: { playerId: "desc" } }, take: 20 });
  if (grouped.length === 0) return [];
  const profiles = await prisma.playerProfile.findMany({
    where: { userId: { in: grouped.map((g) => g.playerId) } },
    select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } }, upazila: { select: { id: true, nameBn: true, nameEn: true } } },
  });
  const by = new Map(profiles.map((p) => [p.userId, p]));
  return grouped.flatMap((g, i) => {
    const p = by.get(g.playerId);
    return p ? [{ rank: i + 1, player: { id: p.id, name: p.user.name, avatarUrl: p.user.avatarUrl, upazila: p.upazila }, gamesPlayed: g._count._all }] : [];
  });
}

export async function leaderboard(q: { sportId: number; upazilaId?: number; districtId?: number; period: Period }, now = new Date()) {
  const [teams, players] = await Promise.all([teamStandings(q, now), playerLeaderboard(q, now)]);
  return { season: teams.season, teams: teams.teams, players };
}

/** A team's public page: its record and latest confirmed results. */
export async function publicTeam(teamId: string, period: Period = "all", now = new Date()) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { ...teamSelect, createdAt: true, sport: { select: { id: true, code: true, nameBn: true, nameEn: true } }, captain: { select: { name: true, status: true } }, _count: { select: { members: true } } },
  });
  if (!team || team.captain.status !== "ACTIVE") throw AppError.notFound("TEAM_NOT_FOUND", "Team not found");
  const { from, to } = range(period, now);
  const results = await confirmedResults({ from, to, teamId });
  const line = empty();
  const recent: { requestId: string; matchAt: string; venueText: string; ourScore: number; theirScore: number; outcome: "WIN" | "DRAW" | "LOSS"; opponent: { id: string; name: string } | null }[] = [];
  for (const r of results) {
    const isHome = r.request.teamId === teamId;
    const gf = isHome ? r.ourScore : r.theirScore;
    const ga = isHome ? r.theirScore : r.ourScore;
    add(line, gf, ga);
    const opp = isHome ? r.opponentTeam : r.request.team;
    if (recent.length < 10) recent.push({ requestId: r.request.id, matchAt: r.request.matchAt.toISOString(), venueText: r.request.venueText, ourScore: gf, theirScore: ga, outcome: gf > ga ? "WIN" : gf === ga ? "DRAW" : "LOSS", opponent: opp ? { id: opp.id, name: opp.name } : null });
  }
  return {
    id: team.id,
    name: team.name,
    logoUrl: imageUrl(team.logoPublicId, team.logoUrl),
    sport: team.sport,
    location: { district: team.district, upazila: team.upazila },
    memberCount: team._count.members,
    foundedAt: team.createdAt.toISOString(),
    record: { ...line, goalDiff: line.gf - line.ga },
    recent,
  };
}
