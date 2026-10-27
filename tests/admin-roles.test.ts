import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, playerUser, prisma, recruiterUser, registerAs, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});
const call = (method: "get" | "post" | "put", path: string, body: object = {}, query: object = {}) =>
  api()[method](`${V1}${path}`).set(admin.auth).query(query).send(body);
const actions = (targetId: string) => prisma.adminAction.findMany({ where: { targetId }, orderBy: { createdAt: "asc" } });

describe("PUT /admin/users/:id/role", () => {
  it("switches player ⇄ recruiter and writes the audit trail", async () => {
    const p = await registerAs("PLAYER", "p@example.com");
    const res = await call("put", `/admin/users/${p.user.id}/role`, { role: "RECRUITER", reason: "Signed up as player by mistake" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("RECRUITER");
    expect(await actions(p.user.id)).toEqual([expect.objectContaining({ action: "USER_ROLE_CHANGE", adminId: admin.user.id, metadata: { from: "PLAYER", to: "RECRUITER" } })]);
    // the user's own token now acts as a recruiter
    expect((await api().get(`${V1}/recruiters/me`).set(p.auth)).status).toBe(404); // recruiter route reachable, no profile yet
  });

  it("refuses: same role, ADMIN as a target value, admins, yourself, deleted users, missing reason", async () => {
    const p = await registerAs("PLAYER", "p@example.com");
    const other = await adminUser("admin2@example.com");
    const gone = await registerAs("PLAYER", "gone@example.com");
    await prisma.user.update({ where: { id: gone.user.id }, data: { status: "DELETED" } });

    expect((await call("put", `/admin/users/${p.user.id}/role`, { role: "PLAYER", reason: "no change" })).status).toBe(409);
    expect((await call("put", `/admin/users/${p.user.id}/role`, { role: "ADMIN", reason: "promote" })).status).toBe(422);
    expect((await call("put", `/admin/users/${p.user.id}/role`, { role: "RECRUITER" })).status).toBe(422);
    expect((await call("put", `/admin/users/${other.user.id}/role`, { role: "PLAYER", reason: "demote" })).status).toBe(403);
    expect((await call("put", `/admin/users/${admin.user.id}/role`, { role: "PLAYER", reason: "self" })).status).toBe(403);
    expect((await call("put", `/admin/users/${gone.user.id}/role`, { role: "RECRUITER", reason: "x y z" })).status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: p.user.id } })).role).toBe("PLAYER");
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

describe("sport profile moderation", () => {
  it("hides and unhides one sport profile, logs both, and rejects repeats", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }, { sportId: w.cricket.id }]);
    const [fb, cr] = await prisma.playerSport.findMany({ where: { profileId: p.profileId }, orderBy: { createdAt: "asc" } });
    expect((await call("post", `/admin/sport-profiles/${fb!.id}/hide`, { reason: "Misleading stats" })).body.data).toEqual({ id: fb!.id, hiddenByAdmin: true });
    expect((await call("post", `/admin/sport-profiles/${fb!.id}/hide`, { reason: "again" })).body.error.code).toBe("SPORT_PROFILE_ALREADY_HIDDEN");
    expect((await prisma.playerSport.findUniqueOrThrow({ where: { id: cr!.id } })).hiddenByAdminAt).toBeNull(); // the other sport is untouched
    expect((await call("post", `/admin/sport-profiles/${fb!.id}/unhide`)).body.data.hiddenByAdmin).toBe(false);
    expect((await call("post", `/admin/sport-profiles/${fb!.id}/unhide`)).body.error.code).toBe("SPORT_PROFILE_NOT_HIDDEN");
    expect((await actions(fb!.id)).map((a) => a.action)).toEqual(["SPORT_PROFILE_HIDE", "SPORT_PROFILE_UNHIDE"]);
    expect((await call("post", "/admin/sport-profiles/nope/hide", { reason: "gone" })).status).toBe(404);
  });
});

describe("recruiter verification", () => {
  it("grants and removes the badge, logging only real changes", async () => {
    const rec = await recruiterUser(w);
    const path = `/admin/recruiters/${rec.recruiterId}/verify`;
    expect((await call("post", path, { verified: true })).body.data.verifiedBadge).toBe(true);
    await call("post", path, { verified: true }); // no-op
    expect((await call("post", path, { verified: false })).body.data.verifiedBadge).toBe(false);
    expect((await actions(rec.recruiterId!)).map((a) => a.action)).toEqual(["RECRUITER_VERIFY", "RECRUITER_UNVERIFY"]);
    expect((await call("post", "/admin/recruiters/nope/verify", { verified: true })).status).toBe(404);
    expect((await call("post", path, { verified: "yes" })).status).toBe(422);
  });
});

describe("directories", () => {
  it("lists players with their sport profiles, and filters by sport, text and hidden state", async () => {
    const a = await playerUser(w, "alpha@example.com", [{ sportId: w.football.id }, { sportId: w.cricket.id }]);
    await playerUser(w, "beta@example.com", [{ sportId: w.cricket.id }]);
    await prisma.playerSport.updateMany({ where: { profileId: a.profileId, sportId: w.cricket.id }, data: { hiddenByAdminAt: new Date() } });

    const all = (await call("get", "/admin/players")).body.data;
    expect(all).toHaveLength(2);
    expect(all.find((p: { id: string }) => p.id === a.profileId).sportProfiles).toHaveLength(2);
    const ids = async (q: object) => (await call("get", "/admin/players", {}, q)).body.data.map((p: { id: string }) => p.id);
    expect(await ids({ sportId: w.football.id })).toEqual([a.profileId]);
    expect(await ids({ q: "alpha" })).toEqual([a.profileId]);
    expect(await ids({ hidden: true })).toEqual([a.profileId]);
    expect(await ids({ hidden: false })).toHaveLength(1);
  });

  it("lists recruiters, filtered by verification and search", async () => {
    const r1 = await recruiterUser(w, "r1@example.com", { organization: "Dhaka Abahani" });
    await recruiterUser(w, "r2@example.com", { organization: "Rangpur Lions" });
    await prisma.recruiterProfile.update({ where: { id: r1.recruiterId! }, data: { verifiedBadge: true } });
    const ids = async (q: object) => (await call("get", "/admin/recruiters", {}, q)).body.data.map((r: { id: string }) => r.id);
    expect(await ids({})).toHaveLength(2);
    expect(await ids({ verified: true })).toEqual([r1.recruiterId]);
    expect(await ids({ q: "abahani" })).toEqual([r1.recruiterId]);
    const users = await call("get", "/admin/users", {}, { role: "RECRUITER" });
    expect(users.body.data).toHaveLength(2);
    expect((await call("get", "/admin/users", {}, { role: "USER" })).status).toBe(422);
  });
});

describe("GET /admin/stats and /admin/me", () => {
  it("summarises the platform", async () => {
    await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const rec = await recruiterUser(w);
    await prisma.recruiterProfile.update({ where: { id: rec.recruiterId! }, data: { verifiedBadge: true } });
    const s = (await call("get", "/admin/stats")).body.data;
    expect(s.users.byRole).toEqual({ ADMIN: 1, PLAYER: 1, RECRUITER: 1 });
    expect(s.users.signedUpLast7Days).toBe(3);
    expect(s.players).toEqual({ profiles: 1, hiddenByAdmin: 0 });
    expect(s.sportProfiles).toEqual([expect.objectContaining({ code: "FOOTBALL", count: 1 })]);
    expect(s.recruiters).toEqual({ profiles: 1, verified: 1 });
    expect(s.moderation.openReports).toBe(0);
    expect((await call("get", "/admin/me")).body.data).toMatchObject({ email: "admin@example.com", role: "ADMIN" });
  });
});
