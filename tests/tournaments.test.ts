import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, notificationsOf, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";
import { bracketSize, drawBracket, roundCount, seedOrder } from "../src/modules/tournaments/bracket.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "put" | "delete", path: string, a: Auth | null, body?: object) => {
  const t = api()[method](`${V1}${path}`);
  const s = a ? t.set(a) : t;
  return body === undefined ? s : s.send(body);
};

describe("bracket", () => {
  it("seed order pairs the strongest with the weakest", () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
  it("sizes and rounds", () => {
    expect([4, 5, 8, 9, 16].map(bracketSize)).toEqual([4, 8, 8, 16, 16]);
    expect(roundCount(8)).toBe(3);
  });
  it("draws every team exactly once, gives byes only when short, and leaves later rounds empty", () => {
    const teams = ["a", "b", "c", "d", "e"];
    const slots = drawBracket(teams);
    const first = slots.filter((s) => s.round === 1);
    expect(first).toHaveLength(4);
    const placed = first.flatMap((s) => [s.home, s.away]).filter(Boolean);
    expect(placed.sort()).toEqual([...teams].sort());
    expect(first.filter((s) => !s.home || !s.away)).toHaveLength(3); // 8 slots, 5 teams: 3 byes
    expect(first.every((s) => s.home || s.away)).toBe(true); // never two byes in one pair
    expect(slots.filter((s) => s.round > 1).every((s) => !s.home && !s.away)).toBe(true);
    expect(slots).toHaveLength(7);
  });
});

async function setup(teamCount: number, maxTeams = 8) {
  const org = await signedIn("org@example.com");
  const t = await call("post", "/tournaments", org.auth, { name: "Kalapara Cup", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, startsAt: hoursFromNow(72).toISOString(), maxTeams });
  expect(t.status).toBe(201);
  const id = t.body.data.id as string;
  const captains: { auth: Auth; teamId: string }[] = [];
  for (let i = 0; i < teamCount; i++) {
    const c = await signedIn(`cap${i}@example.com`);
    const team = await prisma.team.create({ data: { name: `Team ${i}`, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: c.user.id } });
    const r = await call("post", `/tournaments/${id}/teams`, c.auth, { teamId: team.id });
    expect(r.status).toBe(200);
    captains.push({ auth: c.auth, teamId: team.id });
  }
  return { org, id, captains };
}
const playAll = async (org: Auth, id: string) => {
  for (let round = 1; round <= 3; round++) {
    const t = (await call("get", `/tournaments/${id}`, org)).body.data;
    for (const m of t.matches.filter((x: { round: number; home: unknown; away: unknown; winnerTeamId: string | null }) => x.round === round && x.home && x.away && !x.winnerTeamId)) {
      const res = await call("put", `/tournaments/${id}/matches/${m.id}`, org, { homeScore: 2, awayScore: 1 });
      expect(res.status).toBe(200);
    }
  }
};

describe("tournaments", () => {
  it("registration rules: captains of the same sport, no duplicates, capacity, only before the start", async () => {
    const { org, id, captains } = await setup(2, 4);
    expect((await call("post", `/tournaments/${id}/teams`, captains[0]!.auth, { teamId: captains[0]!.teamId })).body.error.code).toBe("TOURNAMENT_ALREADY_IN");
    const other = await signedIn("other@example.com");
    const theirs = await prisma.team.create({ data: { name: "Not mine", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: captains[0]!.teamId ? (await signedIn("x@example.com")).user.id : "" } });
    expect((await call("post", `/tournaments/${id}/teams`, other.auth, { teamId: theirs.id })).status).toBe(422); // not their team
    const bats = await prisma.team.create({ data: { name: "Bats", sportId: w.cricket.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: other.user.id } });
    expect((await call("post", `/tournaments/${id}/teams`, other.auth, { teamId: bats.id })).status).toBe(422); // another sport
    for (let i = 2; i < 4; i++) {
      const c = await signedIn(`more${i}@example.com`);
      const team = await prisma.team.create({ data: { name: `More ${i}`, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: c.user.id } });
      await call("post", `/tournaments/${id}/teams`, c.auth, { teamId: team.id });
    }
    const late = await signedIn("late@example.com");
    const lt = await prisma.team.create({ data: { name: "Late", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: late.user.id } });
    expect((await call("post", `/tournaments/${id}/teams`, late.auth, { teamId: lt.id })).body.error.code).toBe("TOURNAMENT_FULL");
    // the team's captain (or the organiser) can take a team out before the start
    expect((await call("delete", `/tournaments/${id}/teams/${captains[1]!.teamId}`, captains[1]!.auth)).body.data.teamCount).toBe(3);
    expect((await call("delete", `/tournaments/${id}/teams/${captains[0]!.teamId}`, other.auth)).status).toBe(403);
    await call("post", `/tournaments/${id}/teams`, captains[1]!.auth, { teamId: captains[1]!.teamId }); // back in: four teams
    expect((await call("post", `/tournaments/${id}/start`, org.auth)).status).toBe(200);
    expect((await call("delete", `/tournaments/${id}/teams/${captains[0]!.teamId}`, captains[0]!.auth)).body.error.code).toBe("TOURNAMENT_NOT_OPEN");
  });

  it("needs four teams and the organiser to start; the draw has byes for five teams; captains are told", async () => {
    const { org, id, captains } = await setup(3);
    expect((await call("post", `/tournaments/${id}/start`, captains[0]!.auth)).status).toBe(403);
    expect((await call("post", `/tournaments/${id}/start`, org.auth)).body.error.code).toBe("TOURNAMENT_TOO_FEW");
    for (let i = 3; i < 5; i++) {
      const c = await signedIn(`cap${i}@example.com`);
      const team = await prisma.team.create({ data: { name: `Team ${i}`, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: c.user.id } });
      await call("post", `/tournaments/${id}/teams`, c.auth, { teamId: team.id });
    }
    const started = await call("post", `/tournaments/${id}/start`, org.auth);
    expect(started.body.data).toMatchObject({ status: "RUNNING", rounds: 3, teamCount: 5 });
    const round1 = started.body.data.matches.filter((m: { round: number }) => m.round === 1);
    expect(round1.filter((m: { isBye: boolean }) => m.isBye)).toHaveLength(3);
    // byes already moved their team into round 2
    const round2 = started.body.data.matches.filter((m: { round: number }) => m.round === 2);
    expect(round2.reduce((n: number, m: { home: unknown; away: unknown }) => n + (m.home ? 1 : 0) + (m.away ? 1 : 0), 0)).toBe(3);
    await settle();
    expect(await notificationsOf(captains[0]!.teamId ? (await prisma.team.findUniqueOrThrow({ where: { id: captains[0]!.teamId } })).captainId : "", "SYSTEM")).toHaveLength(1);
    expect((await call("post", `/tournaments/${id}/start`, org.auth)).body.error.code).toBe("TOURNAMENT_NOT_OPEN");
  });

  it("plays out to a champion: winners advance, ties need a winner, only the organiser scores", async () => {
    const { org, id, captains } = await setup(4);
    const started = (await call("post", `/tournaments/${id}/start`, org.auth)).body.data;
    const first = started.matches.find((m: { round: number; slot: number }) => m.round === 1 && m.slot === 0);
    expect((await call("put", `/tournaments/${id}/matches/${first.id}`, captains[0]!.auth, { homeScore: 1, awayScore: 0 })).status).toBe(403);
    const final0 = started.matches.find((m: { round: number }) => m.round === 2);
    expect((await call("put", `/tournaments/${id}/matches/${final0.id}`, org.auth, { homeScore: 1, awayScore: 0 })).body.error.code).toBe("TOURNAMENT_MATCH_NOT_READY");
    expect((await call("put", `/tournaments/${id}/matches/${first.id}`, org.auth, { homeScore: 1, awayScore: 1 })).status).toBe(422);
    expect((await call("put", `/tournaments/${id}/matches/${first.id}`, org.auth, { homeScore: 1, awayScore: 1, winner: "AWAY" })).status).toBe(200);
    await playAll(org.auth, id);
    const done = (await call("get", `/tournaments/${id}`, org.auth)).body.data;
    expect(done.status).toBe("FINISHED");
    expect(done.champion).toMatchObject({ name: expect.stringMatching(/^Team /) });
    expect(done.teams.map((t: { id: string }) => t.id)).toContain(done.champion.id);
  });

  it("a score can be corrected until the next match is played, and a changed winner moves on", async () => {
    const { org, id } = await setup(4);
    const started = (await call("post", `/tournaments/${id}/start`, org.auth)).body.data;
    const [m0, m1] = started.matches.filter((m: { round: number }) => m.round === 1);
    await call("put", `/tournaments/${id}/matches/${m0.id}`, org.auth, { homeScore: 3, awayScore: 0 });
    await call("put", `/tournaments/${id}/matches/${m1.id}`, org.auth, { homeScore: 3, awayScore: 0 });
    const fix = await call("put", `/tournaments/${id}/matches/${m0.id}`, org.auth, { homeScore: 0, awayScore: 3 });
    const final = fix.body.data.matches.find((m: { round: number }) => m.round === 2);
    expect(final.home.id).toBe(m0.away.id); // the corrected winner is now in the final
    await call("put", `/tournaments/${id}/matches/${final.id}`, org.auth, { homeScore: 2, awayScore: 0 });
    expect((await call("put", `/tournaments/${id}/matches/${m0.id}`, org.auth, { homeScore: 5, awayScore: 0 })).body.error.code).toBe("TOURNAMENT_MATCH_LOCKED");
  });

  it("is listed and shown publicly without sign-in; cancelling hides the live bracket from new entries", async () => {
    const { org, id } = await setup(4);
    expect((await call("get", "/public/tournaments", null)).body.data).toHaveLength(1);
    const pub = (await call("get", `/public/tournaments/${id}`, null)).body.data;
    expect(pub).toMatchObject({ name: "Kalapara Cup", isOwner: false, myTeams: [] });
    expect((await call("post", `/tournaments/${id}/cancel`, org.auth)).body.data.status).toBe("CANCELLED");
    expect((await call("get", "/public/tournaments", null)).body.data).toHaveLength(0);
  });

  it("limits organisers to five active tournaments and validates the date", async () => {
    const org = await signedIn("org@example.com");
    const body = { name: "Cup", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, startsAt: hoursFromNow(48).toISOString(), maxTeams: 8 };
    expect((await call("post", "/tournaments", org.auth, { ...body, startsAt: hoursFromNow(-1).toISOString() })).status).toBe(422);
    expect((await call("post", "/tournaments", org.auth, { ...body, maxTeams: 6 })).status).toBe(422);
    for (let i = 0; i < 5; i++) expect((await call("post", "/tournaments", org.auth, body)).status).toBe(201);
    expect((await call("post", "/tournaments", org.auth, body)).body.error.code).toBe("TOURNAMENT_LIMIT");
  });
});
