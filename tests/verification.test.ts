import { beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanUploads } from "../src/modules/maintenance/sweep-orphan-uploads.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG } from "./images.js";
import { V1, adminUser, api, notificationsOf, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});
const call = (method: "get" | "post" | "patch", path: string, a: Auth, body: object = {}, query: object = {}) => api()[method](`${V1}${path}`).set(a).query(query).send(body);
const upload = async (a: Auth, type = "verification-doc") => (await api().post(`${V1}/media/images`).set(a).field("type", type).attach("file", JPEG, { filename: "doc.jpg", contentType: "image/jpeg" })).body.data as { publicId: string; url: string };
const LINK = "https://facebook.com/barishalunited";

describe("recruiter verification", () => {
  it("submit links and a document → an admin approves → the badge appears and the recruiter is told", async () => {
    const rec = await recruiterUser(w);
    const doc = await upload(rec.auth);
    const sub = await call("post", "/recruiters/me/verification", rec.auth, { note: "Official club page", evidenceLinks: [LINK], evidenceImages: [{ publicId: doc.publicId }] });
    expect(sub.status).toBe(201);
    expect(sub.body.data).toMatchObject({ kind: "RECRUITER", status: "PENDING", evidenceLinks: [LINK], evidenceImages: [{ url: doc.url }] });
    expect(JSON.stringify(sub.body)).not.toContain("publicId"); // storage bookkeeping stays server-side

    const queue = (await call("get", "/admin/verifications", admin.auth)).body.data;
    expect(queue).toEqual([expect.objectContaining({ id: sub.body.data.id, recruiter: expect.objectContaining({ organization: "Barishal United", verifiedBadge: false }), submitter: expect.objectContaining({ id: rec.user.id }) })]);

    const reviewed = await call("post", `/admin/verifications/${sub.body.data.id}/review`, admin.auth, { approve: true });
    expect(reviewed.body.data.status).toBe("APPROVED");
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(true);
    expect((await notificationsOf(rec.user.id, "VERIFICATION_RESULT"))[0]!.data).toMatchObject({ approved: "true" });
    expect(await prisma.adminAction.count({ where: { action: "VERIFICATION_APPROVE" } })).toBe(1);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK] })).body.error.code).toBe("ALREADY_VERIFIED");
  });

  it("rejection needs a reason that the recruiter can read, and they can try again", async () => {
    const rec = await recruiterUser(w);
    const id = (await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK] })).body.data.id;
    expect((await call("post", `/admin/verifications/${id}/review`, admin.auth, { approve: false })).status).toBe(422);
    await call("post", `/admin/verifications/${id}/review`, admin.auth, { approve: false, note: "The page isn't the club's" });
    expect((await call("get", "/recruiters/me/verification", rec.auth)).body.data).toMatchObject({ status: "REJECTED", reviewNote: "The page isn't the club's" });
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(false);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: ["https://example.org/proof"] })).status).toBe(201);
  });

  it("one request at a time; evidence is required; links must be https", async () => {
    const rec = await recruiterUser(w);
    expect((await call("post", "/recruiters/me/verification", rec.auth, {})).status).toBe(422);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: ["http://insecure.example"] })).status).toBe(422);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: ["javascript:alert(1)"] })).status).toBe(422);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK, LINK, LINK, LINK] })).status).toBe(422);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK] })).status).toBe(201);
    const dup = await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("VERIFICATION_PENDING");
  });

  it("only your own verification-doc uploads can be attached", async () => {
    const rec = await recruiterUser(w);
    const other = await recruiterUser(w, "other@example.com");
    const theirs = await upload(other.auth);
    const wrongKind = await upload(rec.auth, "player-photo");
    for (const publicId of [theirs.publicId, wrongKind.publicId, "playerhaat/test/verification-docs/someone-else/x"]) {
      expect((await call("post", "/recruiters/me/verification", rec.auth, { evidenceImages: [{ publicId }] })).status, publicId).toBe(422);
    }
    expect(await prisma.verificationRequest.count()).toBe(0);
  });

  it("changing who you are drops the badge again", async () => {
    const rec = await recruiterUser(w);
    await prisma.recruiterProfile.update({ where: { id: rec.recruiterId! }, data: { verifiedBadge: true } });
    await call("patch", "/recruiters/me", rec.auth, { organization: "A Different Club" });
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(false);
  });

  it("keeps evidence files safe from the cleanup that deletes unattached uploads", async () => {
    const rec = await recruiterUser(w);
    const attached = await upload(rec.auth);
    const loose = await upload(rec.auth);
    await call("post", "/recruiters/me/verification", rec.auth, { evidenceImages: [{ publicId: attached.publicId }] });
    fakeStorage.files.get(attached.publicId)!.createdAt = new Date(Date.now() - 48 * 3_600_000);
    fakeStorage.files.get(loose.publicId)!.createdAt = new Date(Date.now() - 48 * 3_600_000);
    await sweepOrphanUploads();
    expect(fakeStorage.files.has(attached.publicId)).toBe(true);
    expect(fakeStorage.files.has(loose.publicId)).toBe(false);
    // …and you can't delete a document that's attached to a request
    expect((await api().delete(`${V1}/media/images`).set(rec.auth).send({ publicId: attached.publicId })).status).toBe(409);
  });
});

describe("player stats verification", () => {
  async function playerWithStats() {
    const p = await playerUser(w, "p@example.com");
    await call("post", "/players/me/sports", p.auth, { sportId: w.football.id, positions: ["ST"], skillLevel: 4, stats: { matches: 40, goals: 12 } });
    return p;
  }

  it("approval marks the stats verified on the public profile and in search", async () => {
    const p = await playerWithStats();
    const rec = await recruiterUser(w);
    const sub = await call("post", `/players/me/sports/${w.football.id}/verification`, p.auth, { note: "League record", evidenceLinks: [LINK] });
    expect(sub.status).toBe(201);
    const queued = (await call("get", "/admin/verifications", admin.auth)).body.data[0];
    expect(queued.playerSport).toMatchObject({ sportCode: "FOOTBALL", stats: { matches: 40, goals: 12 }, profileId: p.profileId });

    const pub = async () => (await call("get", `/players/${p.profileId}`, rec.auth)).body.data.sports[0];
    expect((await pub()).statsVerified).toBe(false);
    await call("post", `/admin/verifications/${sub.body.data.id}/review`, admin.auth, { approve: true });
    expect((await pub()).statsVerified).toBe(true);
    const ids = async (q: object) => (await call("get", "/players", rec.auth, {}, q)).body.data.map((c: { id: string }) => c.id);
    expect(await ids({ sportId: w.football.id, statsVerified: true })).toEqual([p.profileId]);
    const unverified = await playerUser(w, "u@example.com", [{ sportId: w.football.id }]);
    expect(await ids({ sportId: w.football.id, statsVerified: true })).not.toContain(unverified.profileId);
  });

  it("changing the numbers removes the mark; saving the same numbers again doesn't", async () => {
    const p = await playerWithStats();
    const rec = await recruiterUser(w);
    const id = (await call("post", `/players/me/sports/${w.football.id}/verification`, p.auth, { evidenceLinks: [LINK] })).body.data.id;
    await call("post", `/admin/verifications/${id}/review`, admin.auth, { approve: true });
    const mark = async () => (await call("get", `/players/${p.profileId}`, rec.auth)).body.data.sports[0].statsVerified;

    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { stats: { goals: 12, matches: 40 }, headline: "Same numbers, different order" });
    expect(await mark()).toBe(true);
    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { currentTeam: "New club" }); // not the stats
    expect(await mark()).toBe(true);
    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { stats: { matches: 41, goals: 12 } });
    expect(await mark()).toBe(false);
  });

  it("needs stats to verify, one request at a time, and an owned sport profile", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const path = `/players/me/sports/${w.football.id}/verification`;
    expect((await call("post", path, p.auth, { evidenceLinks: [LINK] })).status).toBe(422); // no stats yet
    await call("patch", `/players/me/sports/${w.football.id}`, p.auth, { stats: { goals: 3 } });
    expect((await call("post", path, p.auth, { evidenceLinks: [LINK] })).status).toBe(201);
    expect((await call("post", path, p.auth, { evidenceLinks: [LINK] })).body.error.code).toBe("VERIFICATION_PENDING");
    expect((await call("post", `/players/me/sports/${w.cricket.id}/verification`, p.auth, { evidenceLinks: [LINK] })).status).toBe(404);
    const rec = await recruiterUser(w);
    expect((await call("post", path, rec.auth, { evidenceLinks: [LINK] })).status).toBe(403);
    expect((await call("get", path, p.auth)).body.data).toMatchObject({ kind: "PLAYER_STATS", status: "PENDING" });
  });

  it("two admins reviewing at once decide it once; reviewed items can't be re-reviewed", async () => {
    const p = await playerWithStats();
    const admin2 = await adminUser("admin2@example.com");
    const id = (await call("post", `/players/me/sports/${w.football.id}/verification`, p.auth, { evidenceLinks: [LINK] })).body.data.id;
    const results = await Promise.all([call("post", `/admin/verifications/${id}/review`, admin.auth, { approve: true }), call("post", `/admin/verifications/${id}/review`, admin2.auth, { approve: false, note: "Evidence does not match" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call("post", `/admin/verifications/${id}/review`, admin.auth, { approve: true })).status).toBe(409);
    expect(await prisma.adminAction.count({ where: { action: { in: ["VERIFICATION_APPROVE", "VERIFICATION_REJECT"] } } })).toBe(1);
  });

  it("the admin queue filters by kind and status", async () => {
    const p = await playerWithStats();
    const rec = await recruiterUser(w);
    await call("post", `/players/me/sports/${w.football.id}/verification`, p.auth, { evidenceLinks: [LINK] });
    await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK] });
    expect((await call("get", "/admin/verifications", admin.auth)).body.data).toHaveLength(2);
    expect((await call("get", "/admin/verifications", admin.auth, {}, { kind: "RECRUITER" })).body.data).toHaveLength(1);
    expect((await call("get", "/admin/verifications", admin.auth, {}, { status: "APPROVED" })).body.data).toHaveLength(0);
  });
});
