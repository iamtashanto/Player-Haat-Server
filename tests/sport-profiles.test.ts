import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, completedMatch, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
type Auth = Record<string, string>;
const call = (method: "get" | "post" | "patch" | "put" | "delete", path: string, auth: Auth, body: object = {}, query: object = {}) =>
  api()[method](`${V1}${path}`).set(auth).query(query).send(body);

const football = (o: object = {}) => ({ sportId: w.football.id, positions: ["ST"], skillLevel: 4, ...o });
const cricket = (o: object = {}) => ({ sportId: w.cricket.id, positions: ["BATTER"], skillLevel: 3, ...o });

describe("multiple sport profiles under one account", () => {
  it("keeps football and cricket independent, each with its own details", async () => {
    const p = await playerUser(w, "p@example.com");
    await call("post", "/players/me/sports", p.auth, football({ headline: "Left winger", experienceYears: 6, currentTeam: "Kalapara FC", stats: { matches: 40, goals: 12 }, preferredFoot: "LEFT" }));
    const res = await call("post", "/players/me/sports", p.auth, cricket({ experienceYears: 2, stats: { runs: 300, wickets: 4 }, battingStyle: "RIGHT_HAND" }));
    expect(res.status).toBe(201);
    const [f, c] = res.body.data.sports;
    expect(f).toMatchObject({ sportCode: "FOOTBALL", headline: "Left winger", experienceYears: 6, stats: { matches: 40, goals: 12 } });
    expect(c).toMatchObject({ sportCode: "CRICKET", headline: null, experienceYears: 2, stats: { runs: 300, wickets: 4 } });

    // updating one leaves the other alone
    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { experienceYears: 7, currentTeam: null });
    const mine = (await call("get", "/players/me", p.auth)).body.data.sports;
    expect(mine[0]).toMatchObject({ experienceYears: 7, currentTeam: null });
    expect(mine[1]).toMatchObject({ experienceYears: 2 });
  });

  it("validates stats per sport and rejects junk", async () => {
    const p = await playerUser(w, "p@example.com");
    const bad: Array<[string, object]> = [
      ["a cricket stat on football", football({ stats: { runs: 10 } })],
      ["a negative stat", football({ stats: { goals: -1 } })],
      ["a fractional count", football({ stats: { goals: 1.5 } })],
      ["an unknown key", football({ stats: { hacks: 1 } })],
      ["experience above 60", football({ experienceYears: 61 })],
      ["negative experience", football({ experienceYears: -1 })],
      ["an over-long headline", football({ headline: "x".repeat(161) })],
    ];
    for (const [name, body] of bad) expect((await call("post", "/players/me/sports", p.auth, body)).status, name).toBe(422);
    expect((await call("get", "/players/me", p.auth)).body.data.sports).toHaveLength(0);
  });

  it("enforces the experience range in the database too", async () => {
    const p = await playerUser(w, "p@example.com");
    await expect(prisma.playerSport.create({ data: { profileId: p.profileId, sportId: w.football.id, skillLevel: 3, experienceYears: 99 } })).rejects.toThrow();
  });

  it("stores empty stats as null", async () => {
    const p = await playerUser(w, "p@example.com");
    const res = await call("post", "/players/me/sports", p.auth, football({ stats: {} }));
    expect(res.body.data.sports[0].stats).toBeNull();
  });
});

describe("achievements", () => {
  it("are added, listed on the right sport profile, and removed by their owner only", async () => {
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id, positions: ["ST"] }]);
    const b = await playerUser(w, "b@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    const add = await call("post", `/players/me/sports/${w.football.id}/achievements`, a.auth, { title: "District top scorer", year: 2024 });
    expect(add.status).toBe(201);
    const ach = add.body.data.sports[0].achievements;
    expect(ach).toEqual([expect.objectContaining({ title: "District top scorer", year: 2024 })]);

    // another player can't delete it (their own sport profile simply doesn't have it)
    expect((await call("delete", `/players/me/sports/${w.football.id}/achievements/${ach[0].id}`, b.auth)).status).toBe(404);
    expect(await prisma.playerAchievement.count()).toBe(1);

    // visible to others
    const pub = await call("get", `/players/${a.profileId}`, b.auth);
    expect(pub.body.data.sports[0].achievements).toHaveLength(1);

    expect((await call("delete", `/players/me/sports/${w.football.id}/achievements/${ach[0].id}`, a.auth)).status).toBe(200);
    expect(await prisma.playerAchievement.count()).toBe(0);
  });

  it("need a sport profile, valid fields, and respect the cap", async () => {
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const path = (id: number) => `/players/me/sports/${id}/achievements`;
    expect((await call("post", path(w.cricket.id), a.auth, { title: "x" })).status).toBe(404);
    expect((await call("post", path(w.football.id), a.auth, { title: "" })).status).toBe(422);
    expect((await call("post", path(w.football.id), a.auth, { title: "x", year: 1900 })).status).toBe(422);
    expect((await call("post", path(w.football.id), a.auth, { title: "x", extra: 1 })).status).toBe(422);
    for (let i = 0; i < 20; i++) expect((await call("post", path(w.football.id), a.auth, { title: `t${i}` })).status).toBe(201);
    const over = await call("post", path(w.football.id), a.auth, { title: "one too many" });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("PLAYER_ACHIEVEMENT_LIMIT");
  });
});

describe("hiding a single sport profile", () => {
  it("by the player: gone from public view and search, still visible to its owner", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id, positions: ["ST"] }, { sportId: w.cricket.id, positions: ["BATTER"] }]);
    const rec = await recruiterUser(w);
    await call("patch", `/players/me/sports/${w.cricket.id}`, p.auth, { isVisible: false });

    const pub = (await call("get", `/players/${p.profileId}`, rec.auth)).body.data;
    expect(pub.sports.map((s: { sportCode: string }) => s.sportCode)).toEqual(["FOOTBALL"]);
    const mine = (await call("get", "/players/me", p.auth)).body.data;
    expect(mine.sports.map((s: { isVisible: boolean }) => s.isVisible)).toEqual([true, false]);

    expect((await call("get", "/players", rec.auth, {}, { sportId: w.cricket.id })).body.data).toHaveLength(0);
    expect((await call("get", "/players", rec.auth, {}, { sportId: w.football.id })).body.data).toHaveLength(1);
  });

  it("by an admin: the player can't undo it, and it's reported as admin-hidden", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const admin = await adminUser();
    const sp = await prisma.playerSport.findFirstOrThrow({ where: { profileId: p.profileId } });
    await call("post", `/admin/sport-profiles/${sp.id}/hide`, admin.auth, { reason: "Fake stats" });

    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { isVisible: true });
    const mine = (await call("get", "/players/me", p.auth)).body.data.sports[0];
    expect(mine).toMatchObject({ isVisible: true, hiddenByAdmin: true });
    const rec = await recruiterUser(w);
    expect((await call("get", "/players", rec.auth, {}, { sportId: w.football.id })).body.data).toHaveLength(0);
  });
});

describe("recruiter discovery", () => {
  it("is closed until the recruiter finishes onboarding", async () => {
    await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const rec = await recruiterUser(w, "r@example.com", { onboard: false });
    for (const path of ["/players", "/players/anything"]) {
      const res = await call("get", path, rec.auth);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("RECRUITER_PROFILE_REQUIRED");
    }
    await call("post", "/recruiters/me", rec.auth, { type: "SCOUT", districtId: w.patuakhali.id, sportIds: [w.football.id] });
    expect((await call("get", "/players", rec.auth)).status).toBe(200);
  });

  it("filters by experience, skill, name and sport-level rating, and says which sport profile matched", async () => {
    const rec = await recruiterUser(w);
    const veteran = await playerUser(w, "vet@example.com", [{ sportId: w.football.id, positions: ["ST"], skillLevel: 5 }, { sportId: w.cricket.id, positions: ["BOWLER"], skillLevel: 2 }]);
    const rookie = await playerUser(w, "rookie@example.com", [{ sportId: w.football.id, positions: ["ST"], skillLevel: 2 }]);
    await prisma.user.update({ where: { id: veteran.user.id }, data: { name: "Karim Veteran" } });
    await prisma.playerSport.updateMany({ where: { profileId: veteran.profileId, sportId: w.football.id }, data: { experienceYears: 8, avgRating: 4.5, ratingCount: 3 } });
    await prisma.playerSport.updateMany({ where: { profileId: veteran.profileId, sportId: w.cricket.id }, data: { experienceYears: 1 } });
    await prisma.playerSport.updateMany({ where: { profileId: rookie.profileId }, data: { experienceYears: 1 } });

    const ids = (q: object) => call("get", "/players", rec.auth, {}, q).then((r) => r.body.data.map((x: { id: string }) => x.id));
    expect(await ids({ sportId: w.football.id, minExperienceYears: 5 })).toEqual([veteran.profileId]);
    expect(await ids({ sportId: w.cricket.id, minExperienceYears: 5 })).toEqual([]); // experience is per sport, not summed
    expect(await ids({ minSkillLevel: 4 })).toEqual([veteran.profileId]);
    expect(await ids({ q: "karim" })).toEqual([veteran.profileId]);
    expect(await ids({ q: "%%" })).toEqual([]); // wildcard characters are literal
    expect(await ids({ sportId: w.football.id, minRating: 4 })).toEqual([veteran.profileId]);
    expect(await ids({ sportId: w.cricket.id, minRating: 4 })).toEqual([]);

    const card = (await call("get", "/players", rec.auth, {}, { sportId: w.cricket.id })).body.data[0];
    expect(card.matchedSportIds).toEqual([w.cricket.id]);
    expect(card.sports[0].sportCode).toBe("CRICKET"); // the relevant profile leads
    expect((await call("get", "/players", rec.auth, {}, { minExperienceYears: 61 })).status).toBe(422);
  });

  it("drops an account that has been switched to recruiter, and never shows contact details", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const body = JSON.stringify((await call("get", `/players/${p.profileId}`, rec.auth)).body);
    expect(body).not.toMatch(/p@example\.com|passwordHash|"email"|"phone"/);
    await prisma.user.update({ where: { id: p.user.id }, data: { role: "RECRUITER" } });
    expect((await call("get", "/players", rec.auth)).body.data).toHaveLength(0);
    expect((await call("get", `/players/${p.profileId}`, rec.auth)).status).toBe(404);
  });

  it("can't modify anything a player owns", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    for (const [m, path] of [["patch", `/players/${p.profileId}`], ["delete", `/players/${p.profileId}`], ["put", `/players/${p.profileId}`], ["patch", `/players/me/sports/${w.football.id}`]] as const) {
      expect([403, 404, 405], `${m} ${path}`).toContain((await call(m, path, rec.auth, { bio: "hacked" })).status);
    }
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: p.profileId } })).bio).toBeNull();
  });
});

describe("recruiter profile", () => {
  it("validates input and enforces one per recruiter", async () => {
    const rec = await recruiterUser(w, "r@example.com", { onboard: false });
    const ok = { type: "ACADEMY", organization: "Barishal Academy", districtId: w.patuakhali.id, sportIds: [w.football.id, w.cricket.id] };
    for (const bad of [{ ...ok, type: "ROBOT" }, { ...ok, districtId: 9999 }, { ...ok, sportIds: [] }, { ...ok, sportIds: [w.badminton.id] }, { ...ok, sportIds: [w.football.id, w.football.id] }, { ...ok, role: "ADMIN" }]) {
      expect((await call("post", "/recruiters/me", rec.auth, bad)).status).toBe(422);
    }
    expect((await call("post", "/recruiters/me", rec.auth, ok)).status).toBe(201);
    expect((await call("post", "/recruiters/me", rec.auth, ok)).status).toBe(409);
  });

  it("loses its verified badge when the recruiter changes who they are", async () => {
    const rec = await recruiterUser(w);
    await prisma.recruiterProfile.update({ where: { id: rec.recruiterId! }, data: { verifiedBadge: true } });
    await call("patch", "/recruiters/me", rec.auth, { bio: "Now with a longer bio" });
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(true);
    await call("patch", "/recruiters/me", rec.auth, { organization: "Some Other Club" });
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(false);
  });

  it("hides suspended recruiters' public cards", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com");
    await prisma.user.update({ where: { id: rec.user.id }, data: { status: "SUSPENDED" } });
    expect((await call("get", `/recruiters/${rec.recruiterId}`, p.auth)).status).toBe(404);
  });
});

describe("per-sport ratings", () => {
  it("feed the rated sport's profile only, alongside the overall rating", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1 });
    await prisma.playerSport.create({ data: { profileId: players[0]!.profileId, sportId: w.cricket.id, skillLevel: 3 } });
    const res = await call("post", `/requests/${request.id}/ratings`, cap.auth, { applicationId: players[0]!.app.id, scores: { skill: 5, punctuality: 4, behavior: 3 } });
    expect(res.status).toBe(201);
    const sports = await prisma.playerSport.findMany({ where: { profileId: players[0]!.profileId } });
    expect(sports.find((s) => s.sportId === w.football.id)).toMatchObject({ avgRating: 4, ratingCount: 1 });
    expect(sports.find((s) => s.sportId === w.cricket.id)).toMatchObject({ avgRating: 0, ratingCount: 0 });
  });
});
