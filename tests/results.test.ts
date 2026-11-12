import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, notificationsOf, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const put = (a: Auth, id: string, body: object) => api().put(`${V1}/requests/${id}/result`).set(a).send(body);
const getReq = (a: Auth, id: string) => api().get(`${V1}/requests/${id}`).set(a);

async function played() {
  const org = await signedIn("org@example.com");
  const game = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-3), status: "COMPLETED", playersNeeded: 2, playersAccepted: 1 });
  const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
  await makeApplication(game.id, p.user.id, "ACCEPTED");
  return { org, game, p };
}

describe("match results", () => {
  it("the organiser records the score; players see it with the outcome and are told once", async () => {
    const { org, game, p } = await played();
    const res = await put(org.auth, game.id, { ourScore: 3, theirScore: 1, opponentName: "Kuakata Boys" });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ ourScore: 3, theirScore: 1, opponentName: "Kuakata Boys", outcome: "WIN" });
    expect((await getReq(p.auth, game.id)).body.data.result).toMatchObject({ outcome: "WIN", ourScore: 3 });
    await settle();
    const n = await notificationsOf(p.user.id, "RESULT_POSTED");
    expect(n).toHaveLength(1);
    expect(n[0]!.data).toMatchObject({ requestId: game.id });
  });

  it("a correction replaces the score without telling everyone again; draw and loss are derived", async () => {
    const { org, game, p } = await played();
    await put(org.auth, game.id, { ourScore: 2, theirScore: 2 });
    expect((await getReq(org.auth, game.id)).body.data.result.outcome).toBe("DRAW");
    const fixed = await put(org.auth, game.id, { ourScore: 1, theirScore: 4, summary: "walkover after the break" });
    expect(fixed.body.data.result).toMatchObject({ outcome: "LOSS", summary: "walkover after the break" });
    expect(await prisma.matchResult.count()).toBe(1);
    await settle();
    expect(await notificationsOf(p.user.id, "RESULT_POSTED")).toHaveLength(1);
  });

  it("is refused for other people, before the match, for cancelled games, events and bad scores", async () => {
    const { org, game, p } = await played();
    expect((await put(p.auth, game.id, { ourScore: 1, theirScore: 0 })).status).toBe(403);

    const future = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(5) });
    expect((await put(org.auth, future.id, { ourScore: 1, theirScore: 0 })).body.error.code).toBe("REQUEST_NOT_STARTED");

    const cancelled = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-5), status: "CANCELLED" });
    expect((await put(org.auth, cancelled.id, { ourScore: 1, theirScore: 0 })).status).toBe(409);

    const event = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-5), kind: "EVENT" });
    expect((await put(org.auth, event.id, { ourScore: 1, theirScore: 0 })).body.error.code).toBe("RESULT_MATCH_ONLY");

    expect((await put(org.auth, game.id, { ourScore: -1, theirScore: 0 })).status).toBe(422);
    expect((await put(org.auth, game.id, { ourScore: 1.5, theirScore: 0 })).status).toBe(422);
    expect(await prisma.matchResult.count()).toBe(0);
  });

  it("a game with no score shows result: null", async () => {
    const { org, game } = await played();
    expect((await getReq(org.auth, game.id)).body.data.result).toBeNull();
  });
});
