import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, prisma, resetDb, seedWorld, settle, signedIn, notificationsOf, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "put", path: string, a: Auth, body?: object) => {
  const t = api()[method](`${V1}${path}`).set(a);
  return body === undefined ? t : t.send(body);
};
const mkTeam = (captainId: string, name: string, sportId = w.football.id) =>
  prisma.team.create({ data: { name, sportId, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId, members: { create: { userId: captainId, role: "CAPTAIN" } } } });
const challenge = (a: Auth, teamId: string, over: object = {}) => call("post", "/challenges", a, { teamId, proposedAt: hoursFromNow(72).toISOString(), venueText: "Kuakata Ground", ...over });

describe("challenges", () => {
  it("a captain posts a challenge that others see; accepting creates the match with both teams linked", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const ta = await mkTeam(a.user.id, "Alpha");
    const tb = await mkTeam(b.user.id, "Bravo");
    const posted = await challenge(a.auth, ta.id, { notes: "Friendly, 11 a side" });
    expect(posted.status).toBe(201);
    expect(posted.body.data).toMatchObject({ status: "OPEN", isMine: true, team: { name: "Alpha" }, sport: { code: "FOOTBALL" } });

    const seen = await call("get", `/challenges?sportId=${w.football.id}&upazilaId=${w.kalapara.id}`, b.auth);
    expect(seen.body.data).toHaveLength(1);
    expect(seen.body.data[0].isMine).toBe(false);

    const id = posted.body.data.id as string;
    const accepted = await call("post", `/challenges/${id}/accept`, b.auth, { teamId: tb.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: "ACCEPTED", acceptedBy: { name: "Bravo" } });
    const game = await prisma.playerRequest.findUniqueOrThrow({ where: { id: accepted.body.data.requestId } });
    expect(game).toMatchObject({ createdById: a.user.id, teamId: ta.id, opponentTeamId: tb.id, kind: "MATCH", venueText: "Kuakata Ground" });
    expect(game.notes).toContain("Alpha vs Bravo");
    expect((await call("get", "/challenges", b.auth)).body.data).toHaveLength(0); // no longer open
    await settle();
    expect((await notificationsOf(a.user.id, "SYSTEM")).some((n) => (n.data as Record<string, string>).code === "CHALLENGE_ACCEPTED")).toBe(true);

    // after the game the organiser records the score: the opponent is already known and asked to confirm
    await prisma.playerRequest.update({ where: { id: game.id }, data: { matchAt: hoursFromNow(-3) } });
    const rec = await call("put", `/requests/${game.id}/result`, a.auth, { ourScore: 2, theirScore: 1 });
    expect(rec.body.data.result.opponentTeam).toMatchObject({ id: tb.id, name: "Bravo" });
    expect((await call("get", `/requests/${game.id}`, b.auth)).body.data.result.canConfirm).toBe(true);
  });

  it("only one captain can take it; not your own; not with another sport's team; not after the time", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const c = await signedIn("c@example.com");
    const ta = await mkTeam(a.user.id, "Alpha");
    const tb = await mkTeam(b.user.id, "Bravo");
    const tc = await mkTeam(c.user.id, "Charlie");
    const id = (await challenge(a.auth, ta.id)).body.data.id as string;
    expect((await call("post", `/challenges/${id}/accept`, a.auth, { teamId: ta.id })).status).toBe(403);
    const bats = await mkTeam(b.user.id, "Bats", w.cricket.id);
    expect((await call("post", `/challenges/${id}/accept`, b.auth, { teamId: bats.id })).status).toBe(422);
    expect((await call("post", `/challenges/${id}/accept`, b.auth, { teamId: tc.id })).status).toBe(422); // not my team
    const results = await Promise.all([call("post", `/challenges/${id}/accept`, b.auth, { teamId: tb.id }), call("post", `/challenges/${id}/accept`, c.auth, { teamId: tc.id })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.playerRequest.count()).toBe(1);

    const late = (await challenge(a.auth, ta.id)).body.data.id as string;
    await prisma.teamChallenge.update({ where: { id: late }, data: { proposedAt: hoursFromNow(-1) } });
    expect((await call("post", `/challenges/${late}/accept`, b.auth, { teamId: tb.id })).body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("captains only, future times, three open per team, and the owner can withdraw", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const ta = await mkTeam(a.user.id, "Alpha");
    expect((await challenge(b.auth, ta.id)).status).toBe(422);
    expect((await challenge(a.auth, ta.id, { proposedAt: hoursFromNow(-2).toISOString() })).status).toBe(422);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await challenge(a.auth, ta.id)).body.data.id);
    expect((await challenge(a.auth, ta.id)).body.error.code).toBe("CHALLENGE_LIMIT");
    expect((await call("post", `/challenges/${ids[0]}/cancel`, b.auth)).status).toBe(403);
    expect((await call("post", `/challenges/${ids[0]}/cancel`, a.auth)).body.data.status).toBe("CANCELLED");
    expect((await challenge(a.auth, ta.id)).status).toBe(201); // a slot is free again
    expect((await call("get", "/challenges/mine", a.auth)).body.data.length).toBeGreaterThanOrEqual(4);
  });
});
