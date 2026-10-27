import { beforeEach, describe, expect, it } from "vitest";
import { fakePush } from "./fake-push.js";
import { V1, api, completedMatch, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const post = (a: Auth, path: string, body?: object) => api().post(`${V1}${path}`).set(a).send(body);
const get = (a: Auth, path: string, query: Record<string, string | number> = {}) => api().get(`${V1}${path}`).set(a).query(query);
const rate = (a: Auth, requestId: string, body: object) => post(a, `/requests/${requestId}/ratings`, body);
const CAP_SCORES = { skill: 5, punctuality: 4, behavior: 3 };
const profileOf = (userId: string) => prisma.playerProfile.findUniqueOrThrow({ where: { userId } });

describe("captain rates a player", () => {
  it("stores the rating, computes the mean, and updates the player's aggregates", async () => {
    const { cap, request, players } = await completedMatch(w);
    const res = await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores: CAP_SCORES, comment: " Great keeper " });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ direction: "CAPTAIN_TO_PLAYER", scores: CAP_SCORES, overall: 4, comment: "Great keeper", noShow: false });
    expect(await profileOf(players[0]!.user.id)).toMatchObject({ avgRating: 4, ratingCount: 1, noShowCount: 0 });
    expect(await profileOf(players[1]!.user.id)).toMatchObject({ avgRating: 0, ratingCount: 0 });
  });

  it("averages across matches (mean of overalls, not of raw scores)", async () => {
    const a = await completedMatch(w, { players: 1 });
    const player = a.players[0]!;
    await rate(a.cap.auth, a.request.id, { applicationId: player.app.id, scores: { skill: 5, punctuality: 5, behavior: 5 } }); // 5
    const cap2 = await signedIn("cap2@example.com");
    const r2 = await makeRequest(w, cap2.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
    await prisma.playerRequest.update({ where: { id: r2.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
    const app2 = await makeApplication(r2.id, player.user.id, "ACCEPTED");
    await rate(cap2.auth, r2.id, { applicationId: app2.id, scores: { skill: 2, punctuality: 3, behavior: 1 } }); // 2
    expect(await profileOf(player.user.id)).toMatchObject({ avgRating: 3.5, ratingCount: 2 });
  });

  it.each([
    ["a missing score", { skill: 5, punctuality: 4 }],
    ["no scores at all", undefined],
    ["a score of 0", { skill: 0, punctuality: 4, behavior: 3 }],
    ["a score of 6", { skill: 6, punctuality: 4, behavior: 3 }],
    ["a fractional score", { skill: 4.5, punctuality: 4, behavior: 3 }],
    ["a player-side score (payment)", { ...CAP_SCORES, payment: 5 }],
    ["an unknown score key", { ...CAP_SCORES, charisma: 5 }],
  ])("rejects %s", async (_label, scores) => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const res = await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores });
    expect(res.status).toBe(422);
    expect(await prisma.rating.count()).toBe(0);
  });

  it("rejects unknown body fields and over-long comments", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const base = { applicationId: players[0]!.app.id, scores: CAP_SCORES };
    expect((await rate(cap.auth, request.id, { ...base, overall: 5 })).status).toBe(422);
    expect((await rate(cap.auth, request.id, { ...base, raterId: "x" })).status).toBe(422);
    expect((await rate(cap.auth, request.id, { ...base, comment: "x".repeat(501) })).status).toBe(422);
  });

  it("needs a valid applicationId that was accepted on this match", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    expect((await rate(cap.auth, request.id, { scores: CAP_SCORES })).status).toBe(422);
    expect((await rate(cap.auth, request.id, { applicationId: "nope", scores: CAP_SCORES })).body.error.code).toBe("RATING_TARGET_NOT_FOUND");

    const pendingPlayer = await playerUser(w, "pending@example.com", [{ sportId: w.football.id }]);
    const pending = await makeApplication(request.id, pendingPlayer.user.id, "PENDING");
    const withdrawnPlayer = await playerUser(w, "withdrawn@example.com", [{ sportId: w.football.id }]);
    const withdrawn = await makeApplication(request.id, withdrawnPlayer.user.id, "WITHDRAWN");
    for (const a of [pending, withdrawn]) {
      expect((await rate(cap.auth, request.id, { applicationId: a.id, scores: CAP_SCORES })).body.error.code).toBe("RATING_TARGET_NOT_FOUND");
    }
    // an accepted application that belongs to a different match can't be rated here
    const elsewhere = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
    await prisma.playerRequest.update({ where: { id: elsewhere.id }, data: { completedAt: hoursFromNow(-5) } });
    const stray = await playerUser(w, "stray@example.com", [{ sportId: w.football.id }]);
    const foreign = await makeApplication(elsewhere.id, stray.user.id, "ACCEPTED");
    const res = await rate(cap.auth, request.id, { applicationId: foreign.id, scores: CAP_SCORES });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("RATING_TARGET_NOT_FOUND");
    expect(players).toHaveLength(1);
  });
});

describe("player rates the captain", () => {
  it("unpaid match: behavior + organization, no payment; updates the captain's reputation", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2 });
    const res = await rate(players[0]!.auth, request.id, { scores: { behavior: 5, organization: 3 }, comment: "Well run" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ direction: "PLAYER_TO_CAPTAIN", overall: 4 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: cap.user.id } })).toMatchObject({ captainAvgRating: 4, captainRatingCount: 1 });

    await rate(players[1]!.auth, request.id, { scores: { behavior: 1, organization: 2 } }); // 1.5
    expect(await prisma.user.findUniqueOrThrow({ where: { id: cap.user.id } })).toMatchObject({ captainAvgRating: 2.75, captainRatingCount: 2 });
  });

  it("paid match: payment is required", async () => {
    const { request, players } = await completedMatch(w, { players: 1, isPaid: true });
    const missing = await rate(players[0]!.auth, request.id, { scores: { behavior: 5, organization: 3 } });
    expect(missing.status).toBe(422);
    const ok = await rate(players[0]!.auth, request.id, { scores: { payment: 5, behavior: 4, organization: 3 } });
    expect(ok.body.data.overall).toBe(4);
  });

  it("unpaid match: a payment score is rejected", async () => {
    const { request, players } = await completedMatch(w, { players: 1 });
    expect((await rate(players[0]!.auth, request.id, { scores: { payment: 5, behavior: 4, organization: 3 } })).status).toBe(422);
  });

  it("rejects captain-side scores, applicationId and a no-show report from a player", async () => {
    const { request, players } = await completedMatch(w, { players: 1 });
    const p = players[0]!;
    expect((await rate(p.auth, request.id, { scores: { skill: 5, behavior: 5, organization: 5 } })).status).toBe(422);
    expect((await rate(p.auth, request.id, { applicationId: p.app.id, scores: { behavior: 5, organization: 5 } })).status).toBe(422);
    expect((await rate(p.auth, request.id, { noShow: true })).status).toBe(422);
    expect(await prisma.rating.count()).toBe(0);
  });
});

describe("who can rate, and when", () => {
  it("only the poster and accepted players take part", async () => {
    const { request } = await completedMatch(w, { players: 1 });
    const stranger = await signedIn("stranger@example.com");
    const res = await rate(stranger.auth, request.id, { scores: { behavior: 5, organization: 5 } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("RATING_NOT_PARTICIPANT");

    for (const status of ["PENDING", "REJECTED", "WITHDRAWN"] as const) {
      const p = await playerUser(w, `${status}@example.com`, [{ sportId: w.football.id }]);
      await makeApplication(request.id, p.user.id, status);
      expect((await rate(p.auth, request.id, { scores: { behavior: 5, organization: 5 } })).body.error.code).toBe("RATING_NOT_PARTICIPANT");
    }
    expect((await rate(stranger.auth, "nope", {})).body.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("needs the request to be COMPLETED", async () => {
    const cap = await signedIn("cap@example.com");
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    for (const status of ["OPEN", "FILLED", "CANCELLED"] as const) {
      const r = await makeRequest(w, cap.user.id, { status, matchAt: hoursFromNow(-2) });
      const app = await makeApplication(r.id, p.user.id, "ACCEPTED");
      const res = await rate(cap.auth, r.id, { applicationId: app.id, scores: CAP_SCORES });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("REQUEST_NOT_COMPLETED");
    }
  });

  it("closes 7 days after completion — and is still open a minute before", async () => {
    const closed = await completedMatch(w, { players: 1, completedHoursAgo: 7 * 24 + 1 });
    const res = await rate(closed.cap.auth, closed.request.id, { applicationId: closed.players[0]!.app.id, scores: CAP_SCORES });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RATING_WINDOW_CLOSED");
    expect((await rate(closed.players[0]!.auth, closed.request.id, { scores: { behavior: 5, organization: 5 } })).body.error.code).toBe("RATING_WINDOW_CLOSED");

    await resetDb();
    w = await seedWorld();
    const open = await completedMatch(w, { players: 1, completedHoursAgo: 7 * 24 - 1 });
    expect((await rate(open.cap.auth, open.request.id, { applicationId: open.players[0]!.app.id, scores: CAP_SCORES })).status).toBe(201);
  });

  it("is final: a second rating of the same person is RATING_EXISTS and changes nothing", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const body = { applicationId: players[0]!.app.id, scores: CAP_SCORES };
    await rate(cap.auth, request.id, body);
    const again = await rate(cap.auth, request.id, { ...body, scores: { skill: 1, punctuality: 1, behavior: 1 } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("RATING_EXISTS");
    expect(await profileOf(players[0]!.user.id)).toMatchObject({ avgRating: 4, ratingCount: 1 });

    await rate(players[0]!.auth, request.id, { scores: { behavior: 5, organization: 5 } });
    expect((await rate(players[0]!.auth, request.id, { scores: { behavior: 1, organization: 1 } })).body.error.code).toBe("RATING_EXISTS");
  });

  it("requires authentication", async () => {
    expect((await api().post(`${V1}/requests/x/ratings`).send({})).status).toBe(401);
  });
});

describe("no-show strikes", () => {
  it("adds a strike without touching the average or review count, and stores no scores", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const res = await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, noShow: true, comment: "Never came" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ noShow: true, scores: {} });
    expect(await profileOf(players[0]!.user.id)).toMatchObject({ noShowCount: 1, avgRating: 0, ratingCount: 0 });
  });

  it("strikes accumulate next to real reviews, which keep their own average", async () => {
    const a = await completedMatch(w, { players: 1 });
    const player = a.players[0]!;
    await rate(a.cap.auth, a.request.id, { applicationId: player.app.id, scores: { skill: 5, punctuality: 5, behavior: 5 } });

    const strike = async (email: string) => {
      const cap = await signedIn(email);
      const r = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
      await prisma.playerRequest.update({ where: { id: r.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
      const app = await makeApplication(r.id, player.user.id, "ACCEPTED");
      return rate(cap.auth, r.id, { applicationId: app.id, noShow: true });
    };
    await strike("c2@example.com");
    await strike("c3@example.com");
    expect(await profileOf(player.user.id)).toMatchObject({ avgRating: 5, ratingCount: 1, noShowCount: 2 });
  });

  it("can't carry scores, and only the captain can report one", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const res = await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, noShow: true, scores: CAP_SCORES });
    expect(res.status).toBe(422);
    expect(await profileOf(players[0]!.user.id)).toMatchObject({ noShowCount: 0 });
  });

  it("a player marked no-show can't retaliate with a rating, and the match leaves their pending list", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2 });
    await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, noShow: true });
    const res = await rate(players[0]!.auth, request.id, { scores: { behavior: 1, organization: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RATING_NOT_ELIGIBLE");
    expect((await get(players[0]!.auth, "/ratings/pending")).body.data).toEqual([]);
    expect((await rate(players[1]!.auth, request.id, { scores: { behavior: 5, organization: 5 } })).status).toBe(201); // others unaffected
  });
});

describe("aggregates stay exact", () => {
  it("five players rating the captain at once yields the true count and average", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 5 });
    const results = await Promise.all(players.map((p, i) => rate(p.auth, request.id, { scores: { behavior: i + 1, organization: i + 1 } })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const c = await prisma.user.findUniqueOrThrow({ where: { id: cap.user.id } });
    expect(c.captainRatingCount).toBe(5);
    expect(c.captainAvgRating).toBeCloseTo(3, 10); // (1+2+3+4+5)/5
  });

  it("two captains rating the same player at once is also exact", async () => {
    const a = await completedMatch(w, { players: 1 });
    const player = a.players[0]!;
    const cap2 = await signedIn("cap2@example.com");
    const r2 = await makeRequest(w, cap2.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
    await prisma.playerRequest.update({ where: { id: r2.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
    const app2 = await makeApplication(r2.id, player.user.id, "ACCEPTED");
    await Promise.all([
      rate(a.cap.auth, a.request.id, { applicationId: player.app.id, scores: { skill: 5, punctuality: 5, behavior: 5 } }),
      rate(cap2.auth, r2.id, { applicationId: app2.id, scores: { skill: 1, punctuality: 1, behavior: 1 } }),
    ]);
    expect(await profileOf(player.user.id)).toMatchObject({ avgRating: 3, ratingCount: 2 });
  });
});

describe("GET /players/:id/ratings (public reviews)", () => {
  it("lists reviews newest first with the rater's name — never no-shows, never user ids", async () => {
    const a = await completedMatch(w, { players: 1 });
    const player = a.players[0]!;
    await rate(a.cap.auth, a.request.id, { applicationId: player.app.id, scores: CAP_SCORES, comment: "Solid" });
    const cap2 = await signedIn("cap2@example.com");
    const r2 = await makeRequest(w, cap2.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9), sportId: w.football.id });
    await prisma.playerRequest.update({ where: { id: r2.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
    const app2 = await makeApplication(r2.id, player.user.id, "ACCEPTED");
    await rate(cap2.auth, r2.id, { applicationId: app2.id, noShow: true, comment: "secret strike note" });

    const viewer = await signedIn("viewer@example.com");
    const res = await get(viewer.auth, `/players/${player.profileId}/ratings`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      overall: 4,
      scores: CAP_SCORES,
      comment: "Solid",
      rater: { name: "Viewer" },
      request: { sport: { code: "FOOTBALL" } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/secret strike|raterId|rateeId|userId/);
  });

  it("paginates, hides reviews of hidden profiles, and requires auth", async () => {
    const a = await completedMatch(w, { players: 1 });
    const player = a.players[0]!;
    for (let i = 0; i < 4; i++) {
      const cap = await signedIn(`c${i}@example.com`);
      const r = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
      await prisma.playerRequest.update({ where: { id: r.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
      const app = await makeApplication(r.id, player.user.id, "ACCEPTED");
      await rate(cap.auth, r.id, { applicationId: app.id, scores: CAP_SCORES });
      await new Promise((x) => setTimeout(x, 3));
    }
    const viewer = await signedIn("viewer@example.com");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await get(viewer.auth, `/players/${player.profileId}/ratings`, cursor ? { limit: 3, cursor } : { limit: 3 });
      seen.push(...res.body.data.map((x: { id: string }) => x.id));
      cursor = res.body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(4);

    await prisma.playerProfile.update({ where: { id: player.profileId }, data: { hiddenByAdminAt: new Date() } });
    expect((await get(viewer.auth, `/players/${player.profileId}/ratings`)).status).toBe(404);
    expect((await api().get(`${V1}/players/${player.profileId}/ratings`)).status).toBe(401);
  });
});

describe("GET /ratings/pending", () => {
  it("shows the captain who still needs rating, and drops each person once rated", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2 });
    const first = await get(cap.auth, "/ratings/pending");
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0]).toMatchObject({ role: "CAPTAIN", request: { id: request.id, status: "COMPLETED" } });
    expect(first.body.data[0].targets.map((t: { applicationId: string }) => t.applicationId).sort()).toEqual(players.map((p) => p.app.id).sort());
    expect(new Date(first.body.data[0].rateBy).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores: CAP_SCORES });
    expect((await get(cap.auth, "/ratings/pending")).body.data[0].targets).toHaveLength(1);
    await rate(cap.auth, request.id, { applicationId: players[1]!.app.id, scores: CAP_SCORES });
    expect((await get(cap.auth, "/ratings/pending")).body.data).toEqual([]);
  });

  it("shows players the captain to rate, and leaves out matches that aren't completed or are out of window", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await makeRequest(w, cap.user.id, { status: "FILLED" }); // not completed
    const p = players[0]!;
    const open = await makeRequest(w, cap.user.id, { status: "FILLED", matchAt: hoursFromNow(-1) });
    await makeApplication(open.id, p.user.id, "ACCEPTED");
    const old = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-400) });
    await prisma.playerRequest.update({ where: { id: old.id }, data: { completedAt: hoursFromNow(-390) } });
    await makeApplication(old.id, p.user.id, "ACCEPTED");

    const res = await get(p.auth, "/ratings/pending");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ role: "PLAYER", request: { id: request.id }, targets: [{ applicationId: null, name: "Viewer" }] });

    await rate(p.auth, request.id, { scores: { behavior: 5, organization: 5 } });
    expect((await get(p.auth, "/ratings/pending")).body.data).toEqual([]);
  });

  it("orders by most recently completed and requires auth", async () => {
    const cap = await signedIn("cap@example.com");
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const make = async (hoursAgo: number, venue: string) => {
      const r = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-hoursAgo - 3), venueText: venue });
      await prisma.playerRequest.update({ where: { id: r.id }, data: { completedAt: hoursFromNow(-hoursAgo), playersAccepted: 1 } });
      await makeApplication(r.id, p.user.id, "ACCEPTED");
    };
    await make(50, "older");
    await make(5, "newer");
    const res = await get(cap.auth, "/ratings/pending");
    expect(res.body.data.map((x: { request: { venueText: string } }) => x.request.venueText)).toEqual(["newer", "older"]);
    expect((await api().get(`${V1}/ratings/pending`)).status).toBe(401);
  });
});

describe("rating reminder on completion", () => {
  it("nudges every accepted player (not the pending ones) as soon as the match is completed", async () => {
    const cap = await signedIn("cap@example.com");
    const acc = await playerUser(w, "acc@example.com", [{ sportId: w.football.id }]);
    const pen = await playerUser(w, "pen@example.com", [{ sportId: w.football.id }]);
    await prisma.deviceToken.create({ data: { userId: acc.user.id, token: "t".repeat(30), platform: "ANDROID" } });
    const r = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-3), status: "FILLED", playersAccepted: 1 });
    await makeApplication(r.id, acc.user.id, "ACCEPTED");
    await makeApplication(r.id, pen.user.id, "PENDING");

    expect((await post(cap.auth, `/requests/${r.id}/complete`)).status).toBe(200);
    await settle();
    const rows = await prisma.notification.findMany({ where: { type: "RATING_REMINDER" } });
    expect(rows.map((n) => n.userId)).toEqual([acc.user.id]);
    expect(rows[0]!.data).toMatchObject({ requestId: r.id, kind: "now" });
    expect(fakePush.to("t".repeat(30))[0]!.title).toBe("ম্যাচ কেমন ছিল? রেটিং দিন");
  });
});
