import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, giveCredits, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, recruiterUser, requestBody, resetDb, seedWorld, setPricing, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "patch", path: string, a: Auth, body: object = {}, query: object = {}) => api()[method](`${V1}${path}`).set(a).query(query).send(body);
const eventBody = (over: object = {}) => requestBody(w, { kind: "EVENT", title: "Under-17 trial, Barishal", positionsNeeded: [], playersNeeded: 30, ...over });
const balanceOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance;

describe("events", () => {
  it("a recruiter launches an event; players see it in the feed under the events filter", async () => {
    const rec = await recruiterUser(w);
    const player = await playerUser(w, "p@example.com");
    const res = await call("post", "/requests", rec.auth, eventBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: "EVENT", title: "Under-17 trial, Barishal", interested: { count: 0, preview: [] }, captain: { recruiterId: rec.recruiterId } });

    await call("post", "/requests", rec.auth, requestBody(w)); // an ordinary match from the same recruiter
    expect((await call("get", "/requests", player.auth)).body.data).toHaveLength(2);
    const events = (await call("get", "/requests", player.auth, {}, { kind: "EVENT" })).body.data;
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["EVENT"]);
    expect((await call("get", "/requests", player.auth, {}, { kind: "MATCH" })).body.data.map((e: { kind: string }) => e.kind)).toEqual(["MATCH"]);
  });

  it("is for recruiters only, and needs a title", async () => {
    const player = await playerUser(w, "p@example.com");
    const rec = await recruiterUser(w);
    const denied = await call("post", "/requests", player.auth, eventBody());
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("EVENT_RECRUITERS_ONLY");
    expect((await call("post", "/requests", rec.auth, eventBody({ title: undefined }))).status).toBe(422);
    expect((await call("post", "/requests", rec.auth, eventBody({ title: "ab" }))).status).toBe(422);
    expect((await call("post", "/requests", rec.auth, eventBody({ kind: "PARTY" }))).status).toBe(422);
    const match = await call("post", "/requests", rec.auth, requestBody(w, { title: "ignored on a match" }));
    expect(match.body.data).toMatchObject({ kind: "MATCH", title: null });
  });

  it("players tap 'interested'; everyone sees the count and a few faces; the recruiter sees the full list", async () => {
    const rec = await recruiterUser(w);
    const event = (await call("post", "/requests", rec.auth, eventBody())).body.data;
    const players = [];
    for (let i = 0; i < 7; i++) {
      const p = await playerUser(w, `p${i}@example.com`, [{ sportId: w.football.id }]);
      await prisma.user.update({ where: { id: p.user.id }, data: { name: `Player ${i}` } });
      expect((await call("post", `/requests/${event.id}/applications`, p.auth)).status).toBe(201); // no rate, no message needed
      players.push(p);
    }
    const seen = (await call("get", `/requests/${event.id}`, players[0]!.auth)).body.data;
    expect(seen.interested.count).toBe(7);
    expect(seen.interested.preview).toHaveLength(5);
    expect(seen.interested.preview[0]).toMatchObject({ name: "Player 6", profileId: players[6]!.profileId }); // newest first
    expect(seen.myApplication).toMatchObject({ status: "PENDING" });
    expect((await call("get", `/requests/${event.id}/applications`, rec.auth)).body.data).toHaveLength(7);
    expect((await call("get", `/requests/${event.id}/applications`, players[0]!.auth)).status).toBe(403);
  });

  it("leaves out players who hid their profile, and counts drop when someone withdraws", async () => {
    const rec = await recruiterUser(w);
    const event = (await call("post", "/requests", rec.auth, eventBody())).body.data;
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const b = await playerUser(w, "b@example.com", [{ sportId: w.football.id }]);
    const appA = await call("post", `/requests/${event.id}/applications`, a.auth);
    await call("post", `/requests/${event.id}/applications`, b.auth);
    await prisma.playerProfile.update({ where: { id: b.profileId }, data: { isVisible: false } });
    const view = (await call("get", `/requests/${event.id}`, a.auth)).body.data;
    expect(view.interested.count).toBe(2); // they did express interest…
    expect(view.interested.preview.map((p: { profileId: string }) => p.profileId)).toEqual([a.profileId]); // …but a hidden profile never shows
    await call("post", `/applications/${appA.body.data.id}/withdraw`, a.auth);
    expect((await call("get", `/requests/${event.id}`, b.auth)).body.data.interested.count).toBe(1);
  });

  it("recruiters can't apply to events (or anything)", async () => {
    const rec = await recruiterUser(w);
    const other = await recruiterUser(w, "other@example.com");
    const event = (await call("post", "/requests", rec.auth, eventBody())).body.data;
    expect((await call("post", `/requests/${event.id}/applications`, other.auth)).status).toBe(403);
    void makeApplication;
  });
});

describe("boost", () => {
  async function ready() {
    await setPricing({ boost_enabled: true, boost_credit_cost: 5, boost_hours: 24 });
    const rec = await recruiterUser(w);
    const event = (await call("post", "/requests", rec.auth, eventBody())).body.data;
    return { rec, event };
  }

  it("charges credits, features the request for the set time, and extends if boosted again", async () => {
    const { rec, event } = await ready();
    await giveCredits(rec.user.id, 12);
    const viewer = await playerUser(w, "v@example.com");
    expect((await call("get", "/requests/featured", viewer.auth)).body.data).toEqual([]);

    const first = await call("post", `/requests/${event.id}/boost`, rec.auth);
    expect(first.status).toBe(200);
    const until1 = new Date(first.body.data.boostedUntil).getTime();
    expect(until1 - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(await balanceOf(rec.user.id)).toBe(7);
    expect((await call("get", "/requests/featured", viewer.auth)).body.data.map((r: { id: string }) => r.id)).toEqual([event.id]);

    const again = await call("post", `/requests/${event.id}/boost`, rec.auth);
    expect(new Date(again.body.data.boostedUntil).getTime() - until1).toBeGreaterThan(23.9 * 3_600_000); // added on top, not reset
    expect(await balanceOf(rec.user.id)).toBe(2);
    expect((await prisma.creditTransaction.findMany({ where: { reason: "BOOST" } })).map((t) => t.delta)).toEqual([-5, -5]);
  });

  it("needs enough credits and the feature switched on, and only the owner can do it", async () => {
    const { rec, event } = await ready();
    const broke = await call("post", `/requests/${event.id}/boost`, rec.auth);
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe("CREDITS_REQUIRED");
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: event.id } })).boostedUntil).toBeNull();

    await giveCredits(rec.user.id, 50);
    const stranger = await recruiterUser(w, "stranger@example.com");
    await giveCredits(stranger.user.id, 50);
    expect((await call("post", `/requests/${event.id}/boost`, stranger.auth)).status).toBe(403);
    expect(await balanceOf(stranger.user.id)).toBe(50);

    await setPricing({ boost_enabled: false });
    const off = await call("post", `/requests/${event.id}/boost`, rec.auth);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("BOOST_UNAVAILABLE");
    expect(await balanceOf(rec.user.id)).toBe(50);
  });

  it("won't boost a cancelled request, and a boost that has run out stops being featured", async () => {
    const { rec, event } = await ready();
    await giveCredits(rec.user.id, 50);
    await call("post", `/requests/${event.id}/boost`, rec.auth);
    const viewer = await playerUser(w, "v@example.com");
    await prisma.playerRequest.update({ where: { id: event.id }, data: { boostedUntil: hoursFromNow(-1) } });
    expect((await call("get", "/requests/featured", viewer.auth)).body.data).toEqual([]);
    expect((await call("get", `/requests/${event.id}`, viewer.auth)).body.data.boostedUntil).toBeNull();
    await call("post", `/requests/${event.id}/cancel`, rec.auth);
    expect((await call("post", `/requests/${event.id}/boost`, rec.auth)).status).toBe(409);
  });

  it("featured respects hidden requests, filters, and never shows my own", async () => {
    const { rec, event } = await ready();
    await giveCredits(rec.user.id, 50);
    await call("post", `/requests/${event.id}/boost`, rec.auth);
    const viewer = await playerUser(w, "v@example.com");
    expect((await call("get", "/requests/featured", rec.auth)).body.data).toEqual([]); // your own aren't "featured" to you
    expect((await call("get", "/requests/featured", viewer.auth, {}, { sportId: w.cricket.id })).body.data).toEqual([]);
    expect((await call("get", "/requests/featured", viewer.auth, {}, { kind: "EVENT" })).body.data).toHaveLength(1);
    await prisma.playerRequest.update({ where: { id: event.id }, data: { isHidden: true } });
    expect((await call("get", "/requests/featured", viewer.auth)).body.data).toEqual([]);
    void adminUser; void makeRequest; void signedIn;
  });
});
