import { beforeEach, describe, expect, it } from "vitest";
import { backfillMediaAssets } from "../src/lib/storage/backfill-assets.js";
import { imageSize } from "../src/lib/image-size.js";
import { sweepOrphanUploads } from "../src/modules/maintenance/sweep-orphan-uploads.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG, PNG } from "./images.js";
import { V1, api, playerUser, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

describe("media facts are stored for every upload", () => {
  it("avatar, cover, gallery photo and team logo each get a MediaAsset (media id, mime, size, pixels)", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const file = (path: string, field = "file") => api().post(`${V1}${path}`).set(p.auth).attach(field, JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    await api().put(`${V1}/users/me/avatar`).set(p.auth).attach("file", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    await api().put(`${V1}/players/me/media/cover`).set(p.auth).attach("file", JPEG, { filename: "c.jpg", contentType: "image/jpeg" });
    await file("/players/me/media/photos");
    const logo = await api().post(`${V1}/media/images`).set(p.auth).field("type", "team-logo").attach("file", PNG, { filename: "l.png", contentType: "image/png" });
    const assets = await prisma.mediaAsset.findMany();
    expect(assets).toHaveLength(4);
    for (const a of assets) expect(a).toMatchObject({ mime: expect.stringMatching(/^image\//), width: 100, height: 100, size: expect.any(Number) });
    expect(assets.every((a) => !!a.mediaId)).toBe(true);
    expect(assets.map((a) => a.path)).toContain(logo.body.data.publicId);
  });

  it("the profile API gives the cover and gallery sizes, so screens can reserve the space", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await api().put(`${V1}/players/me/media/cover`).set(p.auth).attach("file", JPEG, { filename: "c.jpg", contentType: "image/jpeg" });
    await api().post(`${V1}/players/me/media/photos`).set(p.auth).attach("file", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    await api().post(`${V1}/players/me/media/videos`).set(p.auth).send({ sportId: w.football.id, url: "dQw4w9WgXcQ" });
    const viewer = await signedIn("v@example.com");
    const pub = (await api().get(`${V1}/players/${p.profileId}`).set(viewer.auth)).body.data;
    expect(pub).toMatchObject({ coverWidth: 100, coverHeight: 100 });
    expect(pub.media.find((m: { type: string }) => m.type === "PHOTO")).toMatchObject({ width: 100, height: 100 });
    expect(pub.media.find((m: { type: string }) => m.type === "VIDEO_LINK")).toMatchObject({ width: null, height: null });
  });

  it("a team's logo size comes with the team", async () => {
    const cap = await playerUser(w, "cap@example.com", [{ sportId: w.football.id }]);
    const up = await api().post(`${V1}/media/images`).set(cap.auth).field("type", "team-logo").attach("file", PNG, { filename: "l.png", contentType: "image/png" });
    const team = await api().post(`${V1}/teams`).set(cap.auth).send({ name: "Kalapara XI", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id });
    const withLogo = await api().patch(`${V1}/teams/${team.body.data.id}`).set(cap.auth).send({ logoPublicId: up.body.data.publicId });
    expect(withLogo.status).toBe(200);
    expect(withLogo.body.data).toMatchObject({ logoWidth: 100, logoHeight: 100 });
  });

  it("removing an image removes its facts", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await api().put(`${V1}/players/me/media/cover`).set(p.auth).attach("file", JPEG, { filename: "c.jpg", contentType: "image/jpeg" });
    expect(await prisma.mediaAsset.count()).toBe(1);
    await api().delete(`${V1}/players/me/media/cover`).set(p.auth);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it("reads pixel sizes from png, jpeg and webp headers", () => {
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageSize(png, "image/png")).toEqual({ width: 640, height: 480 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 1, 0, 0]);
    expect(imageSize(jpg, "image/jpeg")).toEqual({ width: 640, height: 480 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.write("WEBP", 8);
    webp.write("VP8X", 12);
    webp.writeUIntLE(639, 24, 3);
    webp.writeUIntLE(479, 27, 3);
    expect(imageSize(webp, "image/webp")).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from("junk"), "image/png")).toBeNull();
  });
});

describe("cleanup keeps the cover (it used to be swept as an orphan after 24 h)", () => {
  it("a profile's cover survives the orphan sweep", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await api().put(`${V1}/players/me/media/cover`).set(p.auth).attach("file", JPEG, { filename: "c.jpg", contentType: "image/jpeg" });
    const cover = (await prisma.playerProfile.findFirstOrThrow()).coverPublicId!;
    fakeStorage.files.get(cover)!.createdAt = new Date(Date.now() - 72 * 3_600_000);
    await sweepOrphanUploads();
    expect(fakeStorage.files.has(cover)).toBe(true);
  });
});

describe("backfill of older uploads", () => {
  it("--dry-run changes nothing; a real run fills the gaps once, notes files the service lost, and is safe twice", async () => {
    const p = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    await prisma.playerMedia.createMany({ data: [{ profileId: p.profileId, type: "PHOTO", url: "u", publicId: "playerhaat/test/player-photos/x/one", order: 0 }, { profileId: p.profileId, type: "PHOTO", url: "u", publicId: "playerhaat/test/player-photos/x/gone", order: 1 }] });
    const lookup = async (path: string) => (path.endsWith("gone") ? null : { mediaId: "mid1", mime: "image/jpeg", width: 800, height: 600, size: 12345 });
    expect(await backfillMediaAssets({ lookup, dryRun: true })).toMatchObject({ referenced: 2, alreadyKnown: 0, filled: 2 });
    expect(await prisma.mediaAsset.count()).toBe(0);
    expect(await backfillMediaAssets({ lookup, dryRun: false })).toMatchObject({ filled: 1, missingInService: 1 });
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { path: "playerhaat/test/player-photos/x/one" } })).toMatchObject({ mediaId: "mid1", width: 800, height: 600, size: 12345 });
    expect(await backfillMediaAssets({ lookup, dryRun: false })).toMatchObject({ alreadyKnown: 1, filled: 0, missingInService: 1 });
  });
});
