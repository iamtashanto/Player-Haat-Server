import { beforeEach, describe, expect, it } from "vitest";
import { dhakaTimeToday, endOfDhakaDay } from "../src/lib/dhaka-time.js";
import { sweepExpiredAvailability } from "../src/modules/players/availability.service.js";
import { V1, api, playerUser, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const put = (auth: Record<string, string>, body: object) => api().put(`${V1}/players/me/availability`).set(auth).send(body);
const searchAvail = (auth: Record<string, string>, q: object = {}) => api().get(`${V1}/players`).set(auth).query({ availableToday: true, ...q });

describe("Dhaka day arithmetic", () => {
  it("rolls over at 00:00 Asia/Dhaka (18:00 UTC), not at UTC midnight", () => {
    expect(endOfDhakaDay(new Date("2026-11-09T17:59:00Z")).toISOString()).toBe("2026-11-09T18:00:00.000Z");
    expect(endOfDhakaDay(new Date("2026-11-09T18:01:00Z")).toISOString()).toBe("2026-11-10T18:00:00.000Z");
  });
  it("turns HH:MM into today's Dhaka instant and rejects junk", () => {
    expect(dhakaTimeToday(new Date("2026-11-09T10:00:00Z"), "20:30")?.toISOString()).toBe("2026-11-09T14:30:00.000Z");
    expect(dhakaTimeToday(new Date("2026-11-09T10:00:00Z"), "25:00")).toBeNull();
  });
});

describe("my availability", () => {
  it("defaults to now → midnight Dhaka and is readable back", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const res = await put(p.auth, { sportIds: [w.football.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const ends = new Date(res.body.data.items[0].endsAt);
    expect(ends.getTime()).toBe(endOfDhakaDay(new Date()).getTime());
    expect((await api().get(`${V1}/players/me/availability`).set(p.auth)).body.data.items).toHaveLength(1);
  });

  it("only for sports on my profile", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const res = await put(p.auth, { sportIds: [w.cricket.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AVAILABILITY_SPORT_NOT_ADDED");
  });

  it("rejects a window that ends in the past or before it starts", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const past = (await put(p.auth, { sportIds: [w.football.id], until: "00:00" })).status; // 00:00 today Dhaka is always past
    expect(past).toBe(400);
    expect((await put(p.auth, { sportIds: [w.football.id], from: "23:00", until: "22:00" })).status).toBe(400);
    expect((await put(p.auth, { sportIds: [w.football.id], until: "99:99" })).status).toBe(400);
  });

  it("replaces the previous set and can be cleared", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }, { sportId: w.cricket.id }]);
    await put(p.auth, { sportIds: [w.football.id, w.cricket.id] });
    const second = await put(p.auth, { sportIds: [w.cricket.id] });
    expect(second.body.data.items.map((i: { sportId: number }) => i.sportId)).toEqual([w.cricket.id]);
    expect((await api().delete(`${V1}/players/me/availability`).set(p.auth)).body.data.items).toEqual([]);
  });

  it("needs a player profile and a player account", async () => {
    const noProfile = await signedIn("np@example.com");
    expect((await put(noProfile.auth, { sportIds: [w.football.id] })).status).toBe(404);
    expect((await api().put(`${V1}/players/me/availability`).send({})).status).toBe(401);
  });
});

describe("nearby available players", () => {
  it("filters by availability, by sport, and flags the card", async () => {
    const viewer = await signedIn("viewer@example.com");
    const free = await playerUser(w, "free@example.com", [{ sportId: w.football.id }, { sportId: w.cricket.id }]);
    await playerUser(w, "busy@example.com", [{ sportId: w.football.id }]);
    await put(free.auth, { sportIds: [w.football.id] });

    const any = await searchAvail(viewer.auth);
    expect(any.body.data).toHaveLength(1);
    expect(any.body.data[0]).toMatchObject({ id: free.profileId, availableToday: true });
    expect((await searchAvail(viewer.auth, { sportId: w.football.id })).body.data).toHaveLength(1);
    expect((await searchAvail(viewer.auth, { sportId: w.cricket.id })).body.data).toHaveLength(0);

    const all = await api().get(`${V1}/players`).set(viewer.auth);
    expect(all.body.data.map((p: { availableToday: boolean }) => p.availableToday).sort()).toEqual([false, true]);
  });

  it("combines with area: available players in another upazila drop out", async () => {
    const viewer = await signedIn("viewer@example.com");
    const near = await playerUser(w, "near@example.com", [{ sportId: w.football.id }]);
    const far = await playerUser(w, "far@example.com", [{ sportId: w.football.id }], { districtId: w.dhaka.id, upazilaId: w.savar.id });
    await put(near.auth, { sportIds: [w.football.id] });
    await put(far.auth, { sportIds: [w.football.id] });
    const res = await searchAvail(viewer.auth, { upazilaId: w.kalapara.id });
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([near.profileId]);
  });

  it("an expired window never shows, even before the sweep job runs, and the sweep then deletes it", async () => {
    const viewer = await signedIn("viewer@example.com");
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await prisma.playerAvailability.create({
      data: { profileId: p.profileId, sportId: w.football.id, startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 60_000) },
    });
    expect((await searchAvail(viewer.auth)).body.data).toHaveLength(0);
    expect((await api().get(`${V1}/players/me/availability`).set(p.auth)).body.data.items).toEqual([]);
    expect(await sweepExpiredAvailability()).toEqual({ deleted: 1 });
    expect(await prisma.playerAvailability.count()).toBe(0);
  });

  it("a window that hasn't started yet doesn't count as available now", async () => {
    const viewer = await signedIn("viewer@example.com");
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await prisma.playerAvailability.create({
      data: { profileId: p.profileId, sportId: w.football.id, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) },
    });
    expect((await searchAvail(viewer.auth)).body.data).toHaveLength(0);
  });
});
