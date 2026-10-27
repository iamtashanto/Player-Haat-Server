import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, makePlayer, prisma, registerUser, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
let viewer: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  viewer = await signedIn("viewer@example.com");
});

const search = (query: Record<string, string | number | boolean> = {}, auth: Auth = viewer.auth) =>
  api().get(`${V1}/players`).set(auth).query(query);
const ids = (res: { body: { data: Array<{ id: string }> } }) => res.body.data.map((p) => p.id);
const names = (res: { body: { data: Array<{ name: string }> } }) => res.body.data.map((p) => p.name).sort();

describe("visibility rules", () => {
  it("returns visible active players, never me, hidden, admin-hidden, suspended or deleted ones", async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: "viewer@example.com" } });
    await prisma.playerProfile.create({ data: { userId: me.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    await makePlayer(w, { name: "Visible" });
    await makePlayer(w, { name: "Hidden", isVisible: false });
    await makePlayer(w, { name: "AdminHidden", hiddenByAdminAt: new Date() });
    await makePlayer(w, { name: "Suspended", status: "SUSPENDED" });
    await makePlayer(w, { name: "Deleted", status: "DELETED" });

    const res = await search();
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Visible"]);
  });

  it("requires authentication", async () => {
    expect((await api().get(`${V1}/players`)).status).toBe(401);
  });

  it("returns an empty page with a null cursor when nothing matches", async () => {
    const res = await search({ sportId: w.football.id });
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ nextCursor: null, limit: 20 });
  });

  it("exposes only card fields — no contact details", async () => {
    await prisma.user.create({ data: { name: "Card", email: "card@example.com", phone: "+8801712345678" } }).then((u) =>
      prisma.playerProfile.create({
        data: { userId: u.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, unionId: w.latachapli.id, avgRating: 4.256, ratingCount: 9 },
      }),
    );
    const res = await search();
    expect(res.body.data[0]).toMatchObject({
      name: "Card",
      rating: { average: 4.26, count: 9 },
      location: { district: { nameEn: "Patuakhali" }, upazila: { nameEn: "Kalapara" }, union: { nameEn: "Latachapli" } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/card@example|8801712345678|passwordHash|bio/);
  });
});

describe("location filters", () => {
  beforeEach(async () => {
    await makePlayer(w, { name: "K-union", upazilaId: w.kalapara.id, unionId: w.latachapli.id });
    await makePlayer(w, { name: "K-plain", upazilaId: w.kalapara.id });
    await makePlayer(w, { name: "G", upazilaId: w.galachipa.id });
    await makePlayer(w, { name: "Savar", districtId: w.dhaka.id, upazilaId: w.savar.id });
  });

  it("filters by union, upazila and district", async () => {
    expect(names(await search({ unionId: w.latachapli.id }))).toEqual(["K-union"]);
    expect(names(await search({ upazilaId: w.kalapara.id }))).toEqual(["K-plain", "K-union"]);
    expect(names(await search({ districtId: w.patuakhali.id }))).toEqual(["G", "K-plain", "K-union"]);
    expect(names(await search({ districtId: w.dhaka.id }))).toEqual(["Savar"]);
  });

  it("combines levels with AND", async () => {
    expect(names(await search({ districtId: w.dhaka.id, upazilaId: w.kalapara.id }))).toEqual([]);
  });

  it("returns everyone with no location filter", async () => {
    expect((await search()).body.data).toHaveLength(4);
  });
});

describe("sport filters", () => {
  const F = () => w.football.id;
  const C = () => w.cricket.id;

  it("filters by sport and by position within that sport", async () => {
    await makePlayer(w, { name: "GK", sports: [{ sportId: F(), positions: ["GK"] }] });
    await makePlayer(w, { name: "ST+CM", sports: [{ sportId: F(), positions: ["ST", "CM"] }] });
    await makePlayer(w, { name: "Bat", sports: [{ sportId: C(), positions: ["BATTER"] }] });
    await makePlayer(w, { name: "None" });

    expect(names(await search({ sportId: F() }))).toEqual(["GK", "ST+CM"]);
    expect(names(await search({ sportId: C() }))).toEqual(["Bat"]);
    expect(names(await search({ sportId: F(), position: "GK" }))).toEqual(["GK"]);
    expect(names(await search({ sportId: F(), position: "CM" }))).toEqual(["ST+CM"]);
    expect(names(await search({ sportId: F(), position: "BATTER" }))).toEqual([]);
  });

  it("requires sportId when filtering by position", async () => {
    expect((await search({ position: "GK" })).status).toBe(422);
  });

  it("matches sport-level filters against the SAME sport entry, not across sports", async () => {
    // Plays football (no khep) and cricket (khep). Must NOT match "football + khep".
    await makePlayer(w, {
      name: "Split",
      sports: [
        { sportId: F(), positions: ["GK"], khepAvailable: false },
        { sportId: C(), positions: ["BATTER"], khepAvailable: true, rateMin: 400, rateMax: 600 },
      ],
    });
    await makePlayer(w, { name: "FootballKhep", sports: [{ sportId: F(), positions: ["GK"], khepAvailable: true }] });

    expect(names(await search({ sportId: F(), khepAvailable: true }))).toEqual(["FootballKhep"]);
    expect(names(await search({ sportId: C(), khepAvailable: true }))).toEqual(["Split"]);
    expect(names(await search({ khepAvailable: true }))).toEqual(["FootballKhep", "Split"]); // any sport
    expect(names(await search({ sportId: F(), khepAvailable: false }))).toEqual(["Split"]);
  });

  it("filters khepAvailable true / false", async () => {
    await makePlayer(w, { name: "Khep", sports: [{ sportId: F(), khepAvailable: true }] });
    await makePlayer(w, { name: "Club", sports: [{ sportId: F(), khepAvailable: false }] });
    expect(names(await search({ khepAvailable: true }))).toEqual(["Khep"]);
    expect(names(await search({ khepAvailable: false }))).toEqual(["Club"]);
  });

  it("matches a position carried by any of the player's entries once, with no duplicates", async () => {
    await makePlayer(w, {
      name: "Both",
      sports: [
        { sportId: F(), positions: ["GK"], khepAvailable: true },
        { sportId: C(), positions: ["BATTER"], khepAvailable: true },
      ],
    });
    const res = await search({ khepAvailable: true });
    expect(res.body.data).toHaveLength(1); // EXISTS, not JOIN: one row per player
  });
});

describe("rate filter (budget overlap)", () => {
  beforeEach(async () => {
    const f = w.football.id;
    await makePlayer(w, { name: "P300-500", sports: [{ sportId: f, khepAvailable: true, rateMin: 300, rateMax: 500 }] });
    await makePlayer(w, { name: "P600-900", sports: [{ sportId: f, khepAvailable: true, rateMin: 600, rateMax: 900 }] });
    await makePlayer(w, { name: "Negotiable", sports: [{ sportId: f, khepAvailable: true }] });
    await makePlayer(w, { name: "NotKhep", sports: [{ sportId: f, khepAvailable: false }] });
  });

  it("rateMax = my ceiling: excludes players whose minimum is above it", async () => {
    expect(names(await search({ rateMax: 550 }))).toEqual(["Negotiable", "P300-500"]);
    expect(names(await search({ rateMax: 299 }))).toEqual(["Negotiable"]);
  });

  it("rateMin = my floor: excludes players whose maximum is below it", async () => {
    expect(names(await search({ rateMin: 700 }))).toEqual(["Negotiable", "P600-900"]);
  });

  it("a budget range matches any overlapping player (inclusive edges)", async () => {
    expect(names(await search({ rateMin: 400, rateMax: 650 }))).toEqual(["Negotiable", "P300-500", "P600-900"]);
    expect(names(await search({ rateMin: 500, rateMax: 600 }))).toEqual(["Negotiable", "P300-500", "P600-900"]);
    expect(names(await search({ rateMin: 501, rateMax: 599 }))).toEqual(["Negotiable"]);
  });

  it("implies khep: players who aren't available for paid matches never match a budget", async () => {
    expect(names(await search({ rateMax: 10_000 }))).not.toContain("NotKhep");
  });

  it("rejects an inverted range", async () => {
    expect((await search({ rateMin: 600, rateMax: 100 })).status).toBe(422);
  });
});

describe("rating filter", () => {
  it("keeps rated players at or above the minimum and drops unrated ones", async () => {
    await makePlayer(w, { name: "Great", avgRating: 4.8, ratingCount: 10 });
    await makePlayer(w, { name: "OK", avgRating: 3.9, ratingCount: 4 });
    await makePlayer(w, { name: "Unrated" });
    expect(names(await search({ minRating: 4 }))).toEqual(["Great"]);
    expect(names(await search({ minRating: 3.9 }))).toEqual(["Great", "OK"]);
    expect(names(await search({ minRating: 0 }))).toEqual(["Great", "OK"]);
    expect((await search({ minRating: 6 })).status).toBe(422);
  });
});

describe("availability day", () => {
  it("matches players with slots on that weekday, per sport entry", async () => {
    const f = w.football.id;
    const c = w.cricket.id;
    await makePlayer(w, { name: "Fri", sports: [{ sportId: f, availability: { fri: ["evening"], mon: ["morning"] } }] });
    await makePlayer(w, { name: "Mon", sports: [{ sportId: f, availability: { mon: ["morning"] } }] });
    await makePlayer(w, { name: "NoAvail", sports: [{ sportId: f }] });
    await makePlayer(w, { name: "CricketFri", sports: [{ sportId: c, availability: { fri: ["morning"] } }] });

    expect(names(await search({ availabilityDay: "fri" }))).toEqual(["CricketFri", "Fri"]);
    expect(names(await search({ availabilityDay: "fri", sportId: f }))).toEqual(["Fri"]);
    expect(names(await search({ availabilityDay: "sun" }))).toEqual([]);
    expect((await search({ availabilityDay: "funday" })).status).toBe(422);
  });
});

describe("sorting", () => {
  it("rating: average desc, then rating count desc, then a stable id order", async () => {
    await makePlayer(w, { name: "A", avgRating: 4.5, ratingCount: 2 });
    await makePlayer(w, { name: "B", avgRating: 4.5, ratingCount: 20 });
    await makePlayer(w, { name: "C", avgRating: 5, ratingCount: 1 });
    await makePlayer(w, { name: "D" });
    const res = await search({ sort: "rating" });
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(["C", "B", "A", "D"]);
    expect((await search()).body.data.map((p: { name: string }) => p.name)).toEqual(["C", "B", "A", "D"]); // default
  });

  it("active: most recently active first", async () => {
    const now = Date.now();
    await makePlayer(w, { name: "Old", lastActiveAt: new Date(now - 7 * 86_400_000) });
    await makePlayer(w, { name: "New", lastActiveAt: new Date(now) });
    await makePlayer(w, { name: "Mid", lastActiveAt: new Date(now - 86_400_000) });
    const res = await search({ sort: "active" });
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(["New", "Mid", "Old"]);
  });

  it("rejects an unknown sort", async () => {
    expect((await search({ sort: "price" })).status).toBe(422);
  });
});

describe("cursor pagination", () => {
  async function walk(query: Record<string, string | number>) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await search(cursor ? { ...query, cursor } : query);
      expect(res.status).toBe(200);
      pages.push(ids(res));
      cursor = res.body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return pages;
  }

  it("pages through ties (identical ratings) without repeats or gaps", async () => {
    const made = [];
    for (let i = 0; i < 7; i++) made.push((await makePlayer(w, { avgRating: 4, ratingCount: 5 })).profileId);
    const pages = await walk({ limit: 3, sort: "rating" });
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(7);
    expect([...all].sort()).toEqual([...made].sort());
  });

  it("pages through mixed ratings in global order", async () => {
    const specs = [
      [5, 3], [5, 1], [4.5, 9], [4.5, 9], [4, 2], [3, 8], [0, 0], [0, 0], [2.5, 4],
    ] as const;
    for (const [avgRating, ratingCount] of specs) await makePlayer(w, { avgRating, ratingCount });
    const full = ids(await search({ limit: 50 }));
    const paged = (await walk({ limit: 2 })).flat();
    expect(paged).toEqual(full);
    expect(full).toHaveLength(9);
  });

  it("pages the 'active' sort, including identical timestamps", async () => {
    const t = new Date("2026-01-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) await makePlayer(w, { lastActiveAt: t });
    for (let i = 0; i < 3; i++) await makePlayer(w, { lastActiveAt: new Date(t.getTime() - (i + 1) * 1000) });
    const full = ids(await search({ limit: 50, sort: "active" }));
    const paged = (await walk({ limit: 3, sort: "active" })).flat();
    expect(paged).toEqual(full);
    expect(new Set(paged).size).toBe(8);
  });

  it("keeps filters applied on every page", async () => {
    for (let i = 0; i < 5; i++) await makePlayer(w, { upazilaId: w.kalapara.id, sports: [{ sportId: w.football.id, positions: ["GK"] }] });
    for (let i = 0; i < 4; i++) await makePlayer(w, { upazilaId: w.galachipa.id, sports: [{ sportId: w.football.id, positions: ["GK"] }] });
    const pages = await walk({ limit: 2, sportId: w.football.id, position: "GK", upazilaId: w.kalapara.id });
    expect(pages.flat()).toHaveLength(5);
  });

  it("reports nextCursor null exactly on the last page, and exact-multiple sizes don't add an empty page", async () => {
    for (let i = 0; i < 4; i++) await makePlayer(w);
    const first = await search({ limit: 2 });
    expect(first.body.meta.nextCursor).toBeTruthy();
    const second = await search({ limit: 2, cursor: first.body.meta.nextCursor });
    expect(second.body.data).toHaveLength(2);
    expect(second.body.meta.nextCursor).toBeNull();
  });

  it("rejects tampered, malformed and cross-sort cursors", async () => {
    for (let i = 0; i < 3; i++) await makePlayer(w);
    const ratingCursor = (await search({ limit: 1, sort: "rating" })).body.meta.nextCursor as string;
    const activeCursor = (await search({ limit: 1, sort: "active" })).body.meta.nextCursor as string;

    expect((await search({ cursor: "garbage" })).status).toBe(422);
    expect((await search({ cursor: Buffer.from('{"s":"rating","v":["x",1,2]}').toString("base64url") })).status).toBe(422);
    expect((await search({ cursor: Buffer.from("{}").toString("base64url") })).status).toBe(422);
    expect((await search({ sort: "active", cursor: ratingCursor })).status).toBe(422);
    expect((await search({ sort: "rating", cursor: activeCursor })).status).toBe(422);
  });

  it("validates limit bounds", async () => {
    expect((await search({ limit: 0 })).status).toBe(422);
    expect((await search({ limit: 51 })).status).toBe(422);
    expect((await search({ limit: 50 })).status).toBe(200);
    expect((await search({ limit: "abc" })).status).toBe(422);
  });
});

describe("safety", () => {
  it("treats filter values as data, never SQL", async () => {
    await makePlayer(w, { name: "Safe", sports: [{ sportId: w.football.id, positions: ["GK"] }] });
    const res = await search({ sportId: w.football.id, position: "' OR 1=1; DROP --" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(await prisma.playerProfile.count()).toBe(1);
  });

  it("ignores unknown query parameters", async () => {
    await makePlayer(w);
    expect((await search({ bogus: "1" })).body.data).toHaveLength(1);
  });
});

describe("recently active", () => {
  it("a token refresh marks the player's profile as active now", async () => {
    const u = await registerUser({ email: "active@example.com" });
    await prisma.playerProfile.create({
      data: { userId: u.user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, lastActiveAt: new Date("2020-01-01") },
    });
    const res = await api().post(`${V1}/auth/refresh`).send({ refreshToken: u.refreshToken });
    expect(res.status).toBe(200);
    const p = await prisma.playerProfile.findUniqueOrThrow({ where: { userId: u.user.id } });
    expect(Date.now() - p.lastActiveAt.getTime()).toBeLessThan(10_000);
  });
});
