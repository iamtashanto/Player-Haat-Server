import { beforeEach, describe, expect, it } from "vitest";
import { fakeStorage } from "./fake-storage.js";
import { V1, adminUser, api, playerUser, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});

async function playerWithMedia() {
  const p = await playerUser(w, "pic@example.com", [{ sportId: w.football.id }]);
  const ids = { avatar: `playerhaat/test/avatars/${p.user.id}/a.jpg`, cover: `playerhaat/test/player-covers/${p.user.id}/c.jpg`, photo: `playerhaat/test/player-photos/${p.user.id}/p.jpg` };
  for (const id of Object.values(ids)) fakeStorage.put(id);
  await prisma.user.update({ where: { id: p.user.id }, data: { avatarUrl: "https://x/a", avatarPublicId: ids.avatar } });
  await prisma.playerProfile.update({ where: { id: p.profileId }, data: { coverUrl: "https://x/c", coverPublicId: ids.cover } });
  const photo = await prisma.playerMedia.create({ data: { profileId: p.profileId, type: "PHOTO", url: "https://x/p", publicId: ids.photo, caption: "Final" } });
  const vid = await prisma.playerMedia.create({ data: { profileId: p.profileId, type: "VIDEO_LINK", url: "https://youtu.be/dQw4w9WgXcQ", source: "YOUTUBE", videoId: "dQw4w9WgXcQ", sportId: w.football.id } });
  return { p, ids, photo, vid };
}
const del = (path: string, reason = "Offensive image") => api().delete(`${V1}${path}`).set(admin.auth).send({ reason });

describe("admin media moderation", () => {
  it("shows the cover and gallery on the user, without storage ids", async () => {
    const { p } = await playerWithMedia();
    const res = await api().get(`${V1}/admin/users/${p.user.id}`).set(admin.auth);
    const pp = res.body.data.playerProfile;
    expect(pp.coverUrl).toContain("player-covers");
    expect(pp.media.map((m: { type: string }) => m.type).sort()).toEqual(["PHOTO", "VIDEO_LINK"]);
    expect(pp.media.find((m: { type: string }) => m.type === "VIDEO_LINK")).toMatchObject({ videoId: "dQw4w9WgXcQ", thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
    expect(JSON.stringify(res.body)).not.toMatch(/PublicId|"publicId"/);
  });

  it("removes a photo: row gone, file deleted, MEDIA_REMOVE audited with the reason", async () => {
    const { p, photo, ids } = await playerWithMedia();
    const res = await del(`/admin/users/${p.user.id}/media/${photo.id}`, "Not a football photo");
    expect(res.status).toBe(200);
    expect(await prisma.playerMedia.findUnique({ where: { id: photo.id } })).toBeNull();
    expect(fakeStorage.files.has(ids.photo)).toBe(false);
    const log = await prisma.adminAction.findFirstOrThrow({ where: { action: "MEDIA_REMOVE" } });
    expect(log).toMatchObject({ targetType: "PLAYER_MEDIA", targetId: photo.id, reason: "Not a football photo" });
  });

  it("removes a video without touching storage; another user's media is a 404", async () => {
    const { p, vid } = await playerWithMedia();
    const other = await playerUser(w, "other@example.com", []);
    expect((await del(`/admin/users/${other.user.id}/media/${vid.id}`)).status).toBe(404);
    const before = fakeStorage.files.size;
    expect((await del(`/admin/users/${p.user.id}/media/${vid.id}`)).status).toBe(200);
    expect(fakeStorage.files.size).toBe(before);
  });

  it("removes the avatar and the cover, deleting both files", async () => {
    const { p, ids } = await playerWithMedia();
    expect((await del(`/admin/users/${p.user.id}/avatar`)).status).toBe(200);
    expect((await del(`/admin/users/${p.user.id}/cover`)).status).toBe(200);
    expect(fakeStorage.files.has(ids.avatar)).toBe(false);
    expect(fakeStorage.files.has(ids.cover)).toBe(false);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: p.user.id } })).toMatchObject({ avatarUrl: null, avatarPublicId: null });
    expect(await prisma.adminAction.count({ where: { action: "MEDIA_REMOVE" } })).toBe(2);
    expect((await del(`/admin/users/${p.user.id}/avatar`)).status).toBe(404); // nothing left to remove
  });

  it("needs a reason, and an admin", async () => {
    const { p, photo } = await playerWithMedia();
    expect((await api().delete(`${V1}/admin/users/${p.user.id}/media/${photo.id}`).set(admin.auth).send({})).status).toBe(422);
    const plain = await signedIn("plain@example.com");
    expect((await api().delete(`${V1}/admin/users/${p.user.id}/media/${photo.id}`).set(plain.auth).send({ reason: "x" })).status).toBe(403);
    expect(await prisma.playerMedia.count()).toBe(2);
  });

  it("reports storage usage through our server", async () => {
    await playerWithMedia();
    const res = await api().get(`${V1}/admin/media/usage`).set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: "fake", files: 3, quotaBytes: 1_000_000 });
    expect((await api().get(`${V1}/admin/media/usage`).set((await signedIn("p2@example.com")).auth)).status).toBe(403);
  });
});
