import { beforeEach, describe, expect, it } from "vitest";
import { revealExpired } from "../src/modules/ratings/ratings.service.js";
import { adminUser, settle, api, completedMatch, hoursFromNow, makeApplication, makeRequest, prisma, resetDb, seedWorld, signedIn, V1, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const call = (m: "get" | "post" | "put" | "delete", a: Auth, path: string, body?: object) => api()[m](`${V1}${path}`).set(a).send(body);
const rate = (a: Auth, requestId: string, body: object) => call("post", a, `/requests/${requestId}/ratings`, body);
const SC = { skill: 4, punctuality: 4, behavior: 4 };
const PL = { behavior: 5, organization: 5 };
const profile = (userId: string) => prisma.playerProfile.findUniqueOrThrow({ where: { userId } });
const later = (days: number) => new Date(Date.now() + days * 86_400_000);

describe("double-blind reveal", () => {
  it("keeps a review hidden (and out of every aggregate) until the other side rates", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const p = players[0]!;
    const first = await rate(cap.auth, request.id, { applicationId: p.app.id, scores: SC });
    expect(first.body.data).toMatchObject({ revealed: false });
    expect(first.body.data.revealsAt).toBeTruthy();
    expect(await profile(p.user.id)).toMatchObject({ ratingCount: 0, avgRating: 0 });
    expect((await call("get", cap.auth, `/players/${p.profileId}/ratings`)).body.data).toHaveLength(0);

    const second = await rate(p.auth, request.id, { scores: PL });
    expect(second.body.data.revealed).toBe(true);
    expect(await profile(p.user.id)).toMatchObject({ ratingCount: 1, avgRating: 4 });
    await settle();
    const note = await prisma.notification.findFirst({ where: { userId: p.user.id, type: "SYSTEM" } });
    expect(JSON.stringify(note?.data)).toContain("REVIEW_REVEALED");
    const captain = await prisma.user.findUniqueOrThrow({ where: { id: cap.user.id } });
    expect(captain).toMatchObject({ captainRatingCount: 1, captainAvgRating: 5 });
    expect((await call("get", cap.auth, `/players/${p.profileId}/ratings`)).body.data).toHaveLength(1);
  });

  it("reveals after the 7-day window even if the other side never rates, and recomputes", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores: SC });
    expect(await revealExpired(new Date())).toBe(0); // window still open
    expect(await revealExpired(later(8))).toBe(1);
    expect(await profile(players[0]!.user.id)).toMatchObject({ ratingCount: 1, avgRating: 4 });
    expect(await revealExpired(later(9))).toBe(0); // idempotent
  });
});

describe("fair averages", () => {
  it("shows 'new' (no average) under 3 revealed reviews and the raw mean at 3+", async () => {
    const p = (await completedMatch(w, { players: 1 })).players[0]!;
    for (let i = 0; i < 3; i++) {
      const cap = await signedIn(`c${i}@example.com`);
      const r = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
      await prisma.playerRequest.update({ where: { id: r.id }, data: { completedAt: hoursFromNow(-5), playersAccepted: 1 } });
      const app = await makeApplication(r.id, p.user.id, "ACCEPTED");
      await rate(cap.auth, r.id, { applicationId: app.id, scores: { skill: 5, punctuality: 5, behavior: i === 2 ? 2 : 5 } });
      await revealExpired(later(8));
      const shown = (await call("get", p.auth, `/players/${p.profileId}`)).body.data.rating;
      if (i < 2) expect(shown).toMatchObject({ isNew: true, average: 0, count: i + 1 });
      else expect(shown).toMatchObject({ isNew: false, count: 3 });
    }
  });

  it("orders by a damped average: one 5★ doesn't beat many good reviews", async () => {
    const { bayesAverage } = await import("../src/modules/ratings/ratings.config.js");
    expect(bayesAverage(5, 1, 3.5)).toBeLessThan(bayesAverage(4.5, 20, 3.5));
    expect(bayesAverage(0, 0, 3.5)).toBe(3.5);
  });
});

describe("no-shows come from attendance only", () => {
  const mark = (a: Auth, id: string, marks: object[]) => call("put", a, `/games/${id}/attendance`, { marks });
  async function game() {
    const cap = await signedIn("org@example.com");
    const request = await makeRequest(w, cap.user.id, { status: "OPEN", matchAt: hoursFromNow(-3), kind: "MATCH" } as never);
    const players = [];
    for (let i = 0; i < 2; i++) {
      const u = await signedIn(`pl${i}@example.com`);
      const prof = await prisma.playerProfile.create({ data: { userId: u.user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
      players.push({ ...u, profileId: prof.id, app: await makeApplication(request.id, u.user.id, "ACCEPTED") });
    }
    return { cap, request, players };
  }

  it("marking absent creates the strike; marking present again removes it", async () => {
    const g = await game();
    const p = g.players[0]!;
    expect((await mark(g.cap.auth, g.request.id, [{ applicationId: p.app.id, status: "NO_SHOW" }])).status).toBe(200);
    expect(await profile(p.user.id)).toMatchObject({ noShowCount: 1 });
    expect(await prisma.rating.count({ where: { rateeId: p.user.id, noShow: true } })).toBe(1);
    expect((await mark(g.cap.auth, g.request.id, [{ applicationId: p.app.id, status: "ATTENDED" }])).status).toBe(200);
    expect(await profile(p.user.id)).toMatchObject({ noShowCount: 0 });
    expect(await prisma.rating.count({ where: { rateeId: p.user.id, noShow: true } })).toBe(0);
  });

  it("an open dispute stops the strike counting; removal keeps it gone, upholding brings it back", async () => {
    const g = await game();
    const p = g.players[0]!;
    await mark(g.cap.auth, g.request.id, [{ applicationId: p.app.id, status: "NO_SHOW" }]);
    const strike = await prisma.rating.findFirstOrThrow({ where: { rateeId: p.user.id, noShow: true } });
    const admin = await adminUser();

    expect((await call("post", g.cap.auth, `/ratings/${strike.id}/dispute`, { reason: "I was there, ask anyone" })).status).toBe(404); // only the ratee
    const d = await call("post", p.auth, `/ratings/${strike.id}/dispute`, { reason: "I was there at 6pm, ask the others" });
    expect(d.status).toBe(201);
    expect(await profile(p.user.id)).toMatchObject({ noShowCount: 0 });
    expect((await call("post", p.auth, `/ratings/${strike.id}/dispute`, { reason: "second try, same thing" })).body.error.code).toBe("DISPUTE_EXISTS");

    const queue = await call("get", admin.auth, "/admin/ratings/disputes?status=OPEN");
    expect(queue.body.data).toHaveLength(1);
    const upheld = await call("post", admin.auth, `/admin/ratings/disputes/${d.body.data.id}/resolve`, { decision: "UPHOLD", note: "Organiser has photos" });
    expect(upheld.body.data.status).toBe("UPHELD");
    expect(await profile(p.user.id)).toMatchObject({ noShowCount: 1 });
    expect(await prisma.adminAction.count({ where: { action: "RATING_DISPUTE_UPHOLD" } })).toBe(1);
    expect((await call("post", admin.auth, `/admin/ratings/disputes/${d.body.data.id}/resolve`, { decision: "REMOVE", note: "again" })).body.error.code).toBe("DISPUTE_RESOLVED");
  });

  it("removing a disputed strike takes it out for good", async () => {
    const g = await game();
    const p = g.players[1]!;
    await mark(g.cap.auth, g.request.id, [{ applicationId: p.app.id, status: "NO_SHOW" }]);
    const strike = await prisma.rating.findFirstOrThrow({ where: { rateeId: p.user.id, noShow: true } });
    const d = await call("post", p.auth, `/ratings/${strike.id}/dispute`, { reason: "I was at the wrong gate, sorry" });
    const admin = await adminUser();
    await call("post", admin.auth, `/admin/ratings/disputes/${d.body.data.id}/resolve`, { decision: "REMOVE", note: "Plausible, no evidence against" });
    expect(await profile(p.user.id)).toMatchObject({ noShowCount: 0 });
    expect(await prisma.rating.findUniqueOrThrow({ where: { id: strike.id } })).toMatchObject({ hiddenByAdminAt: expect.any(Date) });
  });

  it("flags organisers who mark more than half no-shows across 3+ games", async () => {
    const admin = await adminUser();
    const cap = await signedIn("harsh@example.com");
    for (let i = 0; i < 3; i++) {
      const r = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-9) });
      for (let j = 0; j < 2; j++) {
        const u = await signedIn(`h${i}${j}@example.com`);
        const a = await makeApplication(r.id, u.user.id, "ACCEPTED");
        await prisma.application.update({ where: { id: a.id }, data: { attendance: j === 0 ? "NO_SHOW" : "NO_SHOW" } });
      }
    }
    const res = await call("get", admin.auth, "/admin/ratings/flagged-organisers");
    expect(res.body.data).toEqual([expect.objectContaining({ organiserId: cap.user.id, games: 3, noShows: 6 })]);
  });
});

describe("replies", () => {
  async function reviewed() {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores: SC, comment: "Late" });
    await revealExpired(later(8));
    const review = await prisma.rating.findFirstOrThrow({ where: { rateeId: players[0]!.user.id } });
    return { cap, p: players[0]!, review };
  }

  it("the ratee can reply once publicly (<=300 chars) and edit within 24h, not after", async () => {
    const { cap, p, review } = await reviewed();
    expect((await call("post", cap.auth, `/ratings/${review.id}/reply`, { text: "not mine" })).status).toBe(404);
    expect((await call("post", p.auth, `/ratings/${review.id}/reply`, { text: "x".repeat(301) })).status).toBe(422);
    expect((await call("post", p.auth, `/ratings/${review.id}/reply`, { text: "Bus broke down" })).status).toBe(200);
    expect((await call("post", p.auth, `/ratings/${review.id}/reply`, { text: "Bus broke down, sorry" })).status).toBe(200);
    expect((await call("get", cap.auth, `/players/${p.profileId}/ratings`)).body.data[0].reply.text).toBe("Bus broke down, sorry");
    await prisma.rating.update({ where: { id: review.id }, data: { repliedAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await call("post", p.auth, `/ratings/${review.id}/reply`, { text: "edit later" })).body.error.code).toBe("RATING_REPLY_LOCKED");
  });

  it("an admin can remove a reply", async () => {
    const { p, review } = await reviewed();
    await call("post", p.auth, `/ratings/${review.id}/reply`, { text: "rude words" });
    const admin = await adminUser();
    expect((await call("delete", admin.auth, `/admin/ratings/${review.id}/reply`, { reason: "abusive" })).status).toBe(200);
    expect((await prisma.rating.findUniqueOrThrow({ where: { id: review.id } })).replyText).toBeNull();
  });
});

describe("disputes of reviews and admin moderation", () => {
  it("disputes close 7 days after reveal", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await rate(cap.auth, request.id, { applicationId: players[0]!.app.id, scores: SC });
    await revealExpired(later(8));
    const review = await prisma.rating.findFirstOrThrow({ where: { rateeId: players[0]!.user.id } });
    await prisma.rating.update({ where: { id: review.id }, data: { revealedAt: new Date(Date.now() - 8 * 86_400_000) } });
    const res = await call("post", players[0]!.auth, `/ratings/${review.id}/dispute`, { reason: "This is not true at all" });
    expect(res.body.error.code).toBe("DISPUTE_WINDOW_CLOSED");
  });

  it("hiding a review recomputes aggregates; admin history still shows it", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    const p = players[0]!;
    await rate(cap.auth, request.id, { applicationId: p.app.id, scores: SC });
    await revealExpired(later(8));
    expect(await profile(p.user.id)).toMatchObject({ ratingCount: 1 });
    const review = await prisma.rating.findFirstOrThrow({ where: { rateeId: p.user.id } });
    const admin = await adminUser();
    expect((await call("post", admin.auth, `/admin/ratings/${review.id}/hide`, { hidden: true, reason: "Abusive" })).status).toBe(200);
    expect(await profile(p.user.id)).toMatchObject({ ratingCount: 0, avgRating: 0 });
    expect((await call("get", cap.auth, `/players/${p.profileId}/ratings`)).body.data).toHaveLength(0);
    const history = await call("get", admin.auth, `/admin/users/${p.user.id}/ratings`);
    expect(history.body.data[0]).toMatchObject({ id: review.id, hiddenByAdminAt: expect.any(String) });
    await call("post", admin.auth, `/admin/ratings/${review.id}/hide`, { hidden: false, reason: "Reviewed, fine" });
    expect(await profile(p.user.id)).toMatchObject({ ratingCount: 1 });
  });

  it("ordinary users can't use the admin endpoints", async () => {
    const u = await signedIn("plain@example.com");
    expect((await call("get", u.auth, "/admin/ratings/disputes")).status).toBe(403);
  });
});
