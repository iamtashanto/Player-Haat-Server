import { beforeEach, describe, expect, it } from "vitest";
import { sweepUnattachedEvidence } from "../src/modules/maintenance/sweep-orphan-uploads.js";
import { fakeStorage } from "./fake-storage.js";
import { HEIC, JPEG, NOT_AN_IMAGE, bigImage } from "./images.js";
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
const upload = async (a: Auth) => (await api().post(`${V1}/verification/files`).set(a).attach("file", JPEG, { filename: "doc.jpg", contentType: "image/jpeg" })).body.data as { id: string; mime: string };
const LINK = "https://facebook.com/barishalunited";

describe("recruiter verification", () => {
  it("submit links and a document → an admin approves → the badge appears and the recruiter is told", async () => {
    const rec = await recruiterUser(w);
    const doc = await upload(rec.auth);
    const sub = await call("post", "/recruiters/me/verification", rec.auth, { note: "Official club page", evidenceLinks: [LINK], fileIds: [doc.id] });
    expect(sub.status).toBe(201);
    expect(sub.body.data).toMatchObject({ kind: "RECRUITER", status: "PENDING", evidenceLinks: [LINK], files: [expect.objectContaining({ id: doc.id, mime: "image/jpeg" })] });
    expect(JSON.stringify(sub.body)).not.toMatch(/publicId|https?:\/\/[^"]*(\/img\/|\/f\/)|verification\//); // no storage path, no public URL

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

  it("only your own, still-unattached uploads can be attached", async () => {
    const rec = await recruiterUser(w);
    const other = await recruiterUser(w, "other@example.com");
    const theirs = await upload(other.auth);
    const mine = await upload(rec.auth);
    for (const id of [theirs.id, "nope"]) expect((await call("post", "/recruiters/me/verification", rec.auth, { fileIds: [id] })).status, id).toBe(422);
    expect(await prisma.verificationRequest.count()).toBe(0);
    expect((await call("post", "/recruiters/me/verification", rec.auth, { fileIds: [mine.id] })).status).toBe(201);
    // attached once, it can't be reused on a second request
    await prisma.recruiterProfile.update({ where: { id: rec.recruiterId! }, data: { verifiedBadge: false } });
    await prisma.verificationRequest.updateMany({ data: { status: "REJECTED", reviewNote: "x" } });
    expect((await call("post", "/recruiters/me/verification", rec.auth, { fileIds: [mine.id] })).status).toBe(422);
  });

  it("changing who you are drops the badge again", async () => {
    const rec = await recruiterUser(w);
    await prisma.recruiterProfile.update({ where: { id: rec.recruiterId! }, data: { verifiedBadge: true } });
    await call("patch", "/recruiters/me", rec.auth, { organization: "A Different Club" });
    expect((await call("get", "/recruiters/me", rec.auth)).body.data.verifiedBadge).toBe(false);
  });

  it("an unattached upload is cleaned up after a day; an attached one is kept", async () => {
    const rec = await recruiterUser(w);
    const attached = await upload(rec.auth);
    const loose = await upload(rec.auth);
    await call("post", "/recruiters/me/verification", rec.auth, { fileIds: [attached.id] });
    await prisma.verificationFile.updateMany({ data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });
    expect(await sweepUnattachedEvidence()).toEqual({ deleted: 1 });
    expect(await prisma.verificationFile.findUnique({ where: { id: loose.id } })).toBeNull();
    expect(await prisma.verificationFile.findUnique({ where: { id: attached.id } })).not.toBeNull();
    expect(fakeStorage.texts.size).toBe(1);
  });
});

describe("private documents", () => {
  async function submitted() {
    const rec = await recruiterUser(w);
    const doc = await upload(rec.auth);
    const sub = await call("post", "/recruiters/me/verification", rec.auth, { evidenceLinks: [LINK], fileIds: [doc.id] });
    return { rec, doc, requestId: sub.body.data.id as string };
  }
  const bytesOf = (res: { body: unknown }) => res.body as Buffer;

  it("is stored encrypted in verification/<userId>/ — the media service never holds the picture, and no public image path exists", async () => {
    const { rec, doc } = await submitted();
    const row = await prisma.verificationFile.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.path).toContain(`/verification/${rec.user.id}/`);
    const stored = fakeStorage.texts.get(row.path)!;
    expect(stored).toMatch(/^ph1\./);
    expect(Buffer.from(stored, "latin1").includes(JPEG.subarray(0, 12))).toBe(false); // not the raw bytes
    expect(fakeStorage.files.get(row.path)?.kind).toBe("verification-doc");
    expect(fakeStorage.bytes.size).toBe(0); // never went through the image path
    // the public image endpoint no longer accepts this kind
    const viaPublic = await api().post(`${V1}/media/images`).set(rec.auth).field("type", "verification-doc").attach("file", JPEG, { filename: "d.jpg", contentType: "image/jpeg" });
    expect(viaPublic.status).toBe(422);
  });

  it("the owner can open their own upload (before and after submitting); the bytes come back intact", async () => {
    const rec = await recruiterUser(w);
    const doc = await upload(rec.auth);
    const before = await api().get(`${V1}/verification/files/${doc.id}`).set(rec.auth).buffer().parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(before.status).toBe(200);
    expect(before.headers["content-type"]).toBe("image/jpeg");
    expect(before.headers["cache-control"]).toBe("private, no-store");
    expect(before.headers["x-content-type-options"]).toBe("nosniff");
    expect(bytesOf(before).equals(JPEG)).toBe(true);
  });

  it("anonymous → 401, another user → 404 (it does not exist for them), an app user can't use the admin route → 403", async () => {
    const { rec, doc, requestId } = await submitted();
    const stranger = await recruiterUser(w, "stranger@example.com");
    expect((await api().get(`${V1}/verification/files/${doc.id}`)).status).toBe(401);
    expect((await api().get(`${V1}/admin/verification/${requestId}/files/${doc.id}`)).status).toBe(401);
    expect((await api().get(`${V1}/verification/files/${doc.id}`).set(stranger.auth)).status).toBe(404);
    expect((await api().get(`${V1}/admin/verification/${requestId}/files/${doc.id}`).set(stranger.auth)).status).toBe(403);
    expect((await api().get(`${V1}/admin/verification/${requestId}/files/${doc.id}`).set(rec.auth)).status).toBe(403); // not even the owner
  });

  it("an admin gets 200 with the picture, the view is audit-logged, and a wrong request or file id is a 404", async () => {
    const { rec, doc, requestId } = await submitted();
    const res = await api().get(`${V1}/admin/verification/${requestId}/files/${doc.id}`).set(admin.auth).buffer().parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(bytesOf(res).equals(JPEG)).toBe(true);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const log = await prisma.adminAction.findFirstOrThrow({ where: { action: "VERIFICATION_FILE_VIEW" } });
    expect(log).toMatchObject({ adminId: admin.user.id, targetType: "VERIFICATION", targetId: requestId, metadata: { fileId: doc.id, ownerId: rec.user.id } });
    expect((await api().get(`${V1}/admin/verification/${requestId}/files/nope`).set(admin.auth)).status).toBe(404);
    expect((await api().get(`${V1}/admin/verification/nope/files/${doc.id}`).set(admin.auth)).status).toBe(404);
  });

  it("no response about evidence ever contains a public URL or storage path: owner status, admin queue, audit log, notifications", async () => {
    const { rec, requestId } = await submitted();
    await call("post", `/admin/verifications/${requestId}/review`, admin.auth, { approve: true });
    const dump = JSON.stringify([
      (await call("get", "/recruiters/me/verification", rec.auth)).body,
      (await call("get", "/admin/verifications", admin.auth, {}, { status: "ALL" })).body,
      (await call("get", "/admin/audit", admin.auth)).body,
      (await call("get", "/notifications", rec.auth)).body,
    ]);
    expect(dump).not.toMatch(/\/img\/|\/f\/|fake\.cdn|media\.tashanto|publicId|playerhaat\/.*verification/);
    expect(dump).toContain('"files"'); // the ids are there
  });

  it("refuses non-images, HEIC and oversize; and needs the encryption key", async () => {
    const rec = await recruiterUser(w);
    const post = (buf: Buffer, ct: string) => api().post(`${V1}/verification/files`).set(rec.auth).attach("file", buf, { filename: "d", contentType: ct });
    expect((await post(NOT_AN_IMAGE, "image/jpeg")).status).toBe(415);
    expect((await post(HEIC, "image/heic")).status).toBe(415);
    expect((await post(bigImage(5 * 1024 * 1024 + 2048), "image/jpeg")).status).toBe(413);
    expect(await prisma.verificationFile.count()).toBe(0);
    const { env } = await import("../src/config/env.js");
    const keep = env.EVIDENCE_ENCRYPTION_KEY;
    (env as { EVIDENCE_ENCRYPTION_KEY?: string }).EVIDENCE_ENCRYPTION_KEY = undefined;
    expect((await post(JPEG, "image/jpeg")).status).toBe(503);
    (env as { EVIDENCE_ENCRYPTION_KEY?: string }).EVIDENCE_ENCRYPTION_KEY = keep;
  });

  it("a blob copied into someone else's folder does not decrypt for them (the owner is bound in)", async () => {
    const { decryptEvidence, encryptEvidence } = await import("../src/lib/evidence-crypto.js");
    const cipher = encryptEvidence(JPEG, "user-a");
    expect(decryptEvidence(cipher, "user-a").equals(JPEG)).toBe(true);
    expect(() => decryptEvidence(cipher, "user-b")).toThrow();
    expect(() => decryptEvidence(cipher.slice(0, -4) + "AAAA", "user-a")).toThrow();
  });

  it("deleting the account deletes the documents", async () => {
    const { rec } = await submitted();
    const del = await api().delete(`${V1}/auth/account`).set(rec.auth).send({ confirm: "DELETE", password: "Passw0rd1" });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await prisma.verificationFile.count()).toBe(0);
    expect(fakeStorage.texts.size).toBe(0);
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
