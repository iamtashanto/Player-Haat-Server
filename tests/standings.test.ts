import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, notificationsOf, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";
import { seasonOf } from "../src/modules/competition/standings.service.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "put", path: string, a: Auth | null, body?: object) => {
  const t = api()[method](`${V1}${path}`);
  const s = a ? t.set(a) : t;
  return body === undefined ? s : s.send(body);
};
const mkTeam = (captainId: string, name: string, upazilaId = w.kalapara.id) =>
  prisma.team.create({ data: { name, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId, captainId, members: { create: { userId: captainId, role: "CAPTAIN" } } } });

/** Team A's captain posted a match for A that has been played. */
async function played(aName = "Alpha", bName = "Bravo") {
  const a = await signedIn("a@example.com");
  const b = await signedIn("b@example.com");
  const ta = await mkTeam(a.user.id, aName);
  const tb = await mkTeam(b.user.id, bName);
  const game = await makeRequest(w, a.user.id, { matchAt: hoursFromNow(-5), status: "COMPLETED" });
  await prisma.playerRequest.update({ where: { id: game.id }, data: { teamId: ta.id } });
  return { a, b, ta, tb, game };
}
const record = (a: Auth, id: string, body: object) => call("put", `/requests/${id}/result`, a, body);
const table = async (extra = "") => (await call("get", `/public/leaderboard?sportId=${w.football.id}&upazilaId=${w.kalapara.id}${extra}`, null)).body.data;

describe("verified results", () => {
  it("a score does not count until the opponent captain confirms; then both teams get it", async () => {
    const { a, b, ta, tb, game } = await played();
    const res = await record(a.auth, game.id, { ourScore: 3, theirScore: 1, opponentTeamId: tb.id });
    expect(res.body.data.result).toMatchObject({ confirmed: false, canConfirm: false, opponentTeam: { id: tb.id, name: "Bravo" } });
    expect((await table()).teams).toHaveLength(0);
    await settle();
    expect(await notificationsOf(b.user.id, "RESULT_CONFIRM_ASKED")).toHaveLength(1);

    expect((await call("get", `/requests/${game.id}`, b.auth)).body.data.result.canConfirm).toBe(true);
    expect((await call("post", `/requests/${game.id}/result/confirm`, a.auth)).status).toBe(403); // the organiser can't confirm their own score
    const ok = await call("post", `/requests/${game.id}/result/confirm`, b.auth);
    expect(ok.body.data.result).toMatchObject({ confirmed: true, canConfirm: false });

    const rows = (await table()).teams;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rank: 1, team: { id: ta.id }, played: 1, won: 1, points: 3, gf: 3, ga: 1, goalDiff: 2 });
    expect(rows[1]).toMatchObject({ rank: 2, team: { id: tb.id }, played: 1, lost: 1, points: 0, goalDiff: -2 });
    await settle();
    expect((await notificationsOf(a.user.id, "SYSTEM")).some((n) => (n.data as Record<string, string>).code === "RESULT_CONFIRMED")).toBe(true);
  });

  it("changing a confirmed score asks again and takes it out of the table meanwhile", async () => {
    const { a, b, tb, game } = await played();
    await record(a.auth, game.id, { ourScore: 2, theirScore: 2, opponentTeamId: tb.id });
    await call("post", `/requests/${game.id}/result/confirm`, b.auth);
    expect((await table()).teams[0]).toMatchObject({ drawn: 1, points: 1 });
    await record(a.auth, game.id, { ourScore: 5, theirScore: 0 });
    expect((await table()).teams).toHaveLength(0);
    expect((await call("get", `/requests/${game.id}`, b.auth)).body.data.result).toMatchObject({ confirmed: false, canConfirm: true });
    await call("post", `/requests/${game.id}/result/confirm`, b.auth);
    expect((await table()).teams[0]).toMatchObject({ won: 1, points: 3 });
  });

  it("rejecting unlinks the score from the other team for good", async () => {
    const { a, b, tb, game } = await played();
    await record(a.auth, game.id, { ourScore: 9, theirScore: 0, opponentTeamId: tb.id });
    const out = await call("post", `/requests/${game.id}/result/reject`, b.auth);
    expect(out.body.data.result).toMatchObject({ opponentTeam: null, confirmed: false });
    expect((await table()).teams).toHaveLength(0);
    expect((await call("post", `/requests/${game.id}/result/confirm`, b.auth)).status).toBe(404);
  });

  it("an opponent needs your own team on the game, the same sport, and not yourself", async () => {
    const { a, b, ta, tb, game } = await played();
    const loose = await makeRequest(w, a.user.id, { matchAt: hoursFromNow(-6), status: "COMPLETED" });
    expect((await record(a.auth, loose.id, { ourScore: 1, theirScore: 0, opponentTeamId: tb.id })).body.error.code).toBe("RESULT_TEAM_REQUIRED");
    expect((await record(a.auth, game.id, { ourScore: 1, theirScore: 0, opponentTeamId: ta.id })).status).toBe(422);
    expect((await record(a.auth, game.id, { ourScore: 1, theirScore: 0, opponentTeamId: "nope" })).status).toBe(422);
    const cricket = await prisma.team.create({ data: { name: "Bats", sportId: w.cricket.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: b.user.id } });
    expect((await record(a.auth, game.id, { ourScore: 1, theirScore: 0, opponentTeamId: cricket.id })).status).toBe(422);
  });

  it("orders by points, then goal difference; only this season unless asked for all", async () => {
    const { a, b, tb, game } = await played();
    await record(a.auth, game.id, { ourScore: 1, theirScore: 0, opponentTeamId: tb.id });
    await call("post", `/requests/${game.id}/result/confirm`, b.auth);
    const old = await makeRequest(w, a.user.id, { matchAt: new Date(seasonOf().from.getTime() - 5 * 24 * 3_600_000), status: "COMPLETED" });
    await prisma.playerRequest.update({ where: { id: old.id }, data: { teamId: (await prisma.team.findFirstOrThrow({ where: { name: "Alpha" } })).id } });
    await record(a.auth, old.id, { ourScore: 0, theirScore: 4, opponentTeamId: tb.id });
    await call("post", `/requests/${old.id}/result/confirm`, b.auth);
    const season = (await table()).teams;
    expect(season[0]).toMatchObject({ team: { name: "Alpha" }, played: 1, points: 3 });
    const all = (await table("&period=all")).teams;
    expect(all.find((r: { team: { name: string } }) => r.team.name === "Alpha")).toMatchObject({ played: 2, points: 3, gf: 1, ga: 4 });
  });
});

describe("public team page and player leaderboard", () => {
  it("shows the record and recent confirmed results, without members or the join code", async () => {
    const { a, b, ta, tb, game } = await played();
    await record(a.auth, game.id, { ourScore: 2, theirScore: 0, opponentTeamId: tb.id });
    await call("post", `/requests/${game.id}/result/confirm`, b.auth);
    const res = await call("get", `/public/teams/${ta.id}`, null);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Alpha", record: { played: 1, won: 1, points: 3 }, recent: [{ ourScore: 2, theirScore: 0, outcome: "WIN", opponent: { name: "Bravo" } }] });
    expect(JSON.stringify(res.body)).not.toContain(ta.joinCode);
    expect(res.body.data.members).toBeUndefined();
    const theirs = (await call("get", `/public/teams/${tb.id}`, null)).body.data;
    expect(theirs.recent[0]).toMatchObject({ ourScore: 0, theirScore: 2, outcome: "LOSS", opponent: { name: "Alpha" } });
    expect((await call("get", "/public/teams/nope", null)).status).toBe(404);
  });

  it("ranks visible players by games they attended in the area", async () => {
    const org = await signedIn("org@example.com");
    const p1 = await playerUser(w, "p1@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    const p2 = await playerUser(w, "p2@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    for (let i = 0; i < 2; i++) {
      const g = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-3 - i), status: "COMPLETED" });
      const app = await makeApplication(g.id, p1.user.id, "ACCEPTED");
      await prisma.application.update({ where: { id: app.id }, data: { attendance: "ATTENDED" } });
      if (i === 0) await prisma.application.update({ where: { id: (await makeApplication(g.id, p2.user.id, "ACCEPTED")).id }, data: { attendance: "ATTENDED" } });
    }
    const players = (await table()).players;
    expect(players.map((p: { gamesPlayed: number }) => p.gamesPlayed)).toEqual([2, 1]);
    await prisma.playerProfile.update({ where: { userId: p2.user.id }, data: { isVisible: false } });
    expect((await table()).players).toHaveLength(1);
  });

  it("validates the filters", async () => {
    expect((await call("get", "/public/leaderboard", null)).status).toBe(422);
    expect((await call("get", `/public/leaderboard?sportId=${w.football.id}&upazilaId=1&districtId=1`, null)).status).toBe(422);
  });
});
