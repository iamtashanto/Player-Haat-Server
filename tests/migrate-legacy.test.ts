import { beforeEach, describe, expect, it } from "vitest";
import { isLegacyPublicId, migrateLegacyImages } from "../src/lib/storage/migrate-legacy.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG } from "./images.js";
import { prisma, registerUser, resetDb, seedWorld } from "./helpers.js";

let userId: string;
beforeEach(async () => {
  await resetDb();
  const w = await seedWorld();
  const { user } = await registerUser();
  userId = user.id;
  await prisma.user.update({ where: { id: userId }, data: { avatarUrl: "https://res.cloudinary.com/x/a", avatarPublicId: "playerhaat/test/avatars/u/old-avatar" } });
  const profile = await prisma.playerProfile.create({ data: { userId, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
  await prisma.playerMedia.createMany({
    data: [
      { profileId: profile.id, type: "PHOTO", url: "https://res.cloudinary.com/x/p1", publicId: "playerhaat/test/player-photos/u/old-1" },
      { profileId: profile.id, type: "PHOTO", url: "https://media.example/img/-/playerhaat/test/player-photos/u/new-1.jpg", publicId: "playerhaat/test/player-photos/u/new-1.jpg" },
      { profileId: profile.id, type: "VIDEO_LINK", url: "https://youtu.be/dQw4w9WgXcQ", source: "YOUTUBE", videoId: "dQw4w9WgXcQ", sportId: w.football.id },
    ],
  });
});

const deps = (over: Partial<Parameters<typeof migrateLegacyImages>[0]> = {}, deleted: string[] = []) => ({
  dryRun: false,
  fetchImage: async () => JPEG,
  upload: (b: Buffer, o: Parameters<typeof fakeStorage.uploadImage>[1]) => fakeStorage.uploadImage(b, { ...o, publicId: `${o.publicId}.jpg` }),
  deleteOld: async (id: string) => void deleted.push(id),
  ...over,
});

describe("Cloudinary → media service migration", () => {
  it("tells old ids from new paths", () => {
    expect(isLegacyPublicId("playerhaat/test/avatars/u/abc")).toBe(true);
    expect(isLegacyPublicId("playerhaat/test/avatars/u/abc-x1y2.jpg")).toBe(false);
    expect(isLegacyPublicId(null)).toBe(false);
  });

  it("--dry-run counts and changes nothing", async () => {
    const r = await migrateLegacyImages(deps({ dryRun: true }));
    expect(r).toMatchObject({ found: 2, migrated: 0, skippedAlreadyMigrated: 1, byKind: { avatar: 1, "player-photo": 1 } });
    expect(fakeStorage.files.size).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).avatarPublicId).toBe("playerhaat/test/avatars/u/old-avatar");
  });

  it("moves the images, rewrites the references and deletes the old copies — and a second run finds nothing", async () => {
    const deleted: string[] = [];
    const r = await migrateLegacyImages(deps({}, deleted));
    expect(r).toMatchObject({ found: 2, migrated: 2, failed: 0, oldDeleted: 2 });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.avatarPublicId).toMatch(new RegExp(`/avatars/${userId}/.+\\.jpg$`));
    expect(user.avatarUrl).toContain("fake.cdn");
    const photos = await prisma.playerMedia.findMany({ where: { type: "PHOTO" } });
    expect(photos.every((p) => !isLegacyPublicId(p.publicId))).toBe(true);
    expect(deleted.sort()).toEqual(["playerhaat/test/avatars/u/old-avatar", "playerhaat/test/player-photos/u/old-1"]);
    expect(fakeStorage.files.size).toBe(2);

    const again = await migrateLegacyImages(deps({}, deleted));
    expect(again).toMatchObject({ found: 0, migrated: 0, skippedAlreadyMigrated: 3 });
    expect(fakeStorage.files.size).toBe(2);
  });

  it("a failure leaves that row on the old reference, nothing half-written, and the next run retries it", async () => {
    let n = 0;
    const r = await migrateLegacyImages(deps({ fetchImage: async () => { if (n++ === 0) throw new Error("download failed (404)"); return JPEG; } }));
    expect(r).toMatchObject({ found: 2, migrated: 1, failed: 1 });
    const left = await migrateLegacyImages(deps());
    expect(left).toMatchObject({ found: 1, migrated: 1, failed: 0 });
    expect((await migrateLegacyImages(deps())).found).toBe(0);
  });

  it("does not migrate a source that is not an image", async () => {
    const r = await migrateLegacyImages(deps({ fetchImage: async () => Buffer.from("<html>not an image at all</html>") }));
    expect(r).toMatchObject({ migrated: 0, failed: 2 });
    expect(fakeStorage.files.size).toBe(0);
  });
});
