import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/lib/clock.js";
import { fakePush } from "./fake-push.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG } from "./images.js";
import { V1, adminUser, api, makeRequest, playerUser, prisma, recruiterUser, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

let w: World;
const realNow = clock.now;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
afterEach(() => {
  clock.now = realNow;
});
const logo = (a: Record<string, string>, buf = JPEG) => api().put(`${V1}/recruiters/me/logo`).set(a).attach("file", buf, { filename: "l.jpg", contentType: "image/jpeg" });

describe("organisation logo", () => {
  it("is set on the recruiter, replaces (and deletes) the old file, and clears", async () => {
    const rec = await recruiterUser(w);
    const first = await logo(rec.auth);
    expect(first.status).toBe(200);
    expect(first.body.data.logoUrl).toContain("/recruiter-logos/" + rec.user.id + "/");
    const old = (await prisma.recruiterProfile.findFirstOrThrow()).logoPublicId!;
    const second = await logo(rec.auth);
    expect(second.body.data.logoUrl).not.toBe(first.body.data.logoUrl);
    expect(fakeStorage.files.has(old)).toBe(false);
    expect(fakeStorage.files.size).toBe(1);
    expect((await api().delete(`${V1}/recruiters/me/logo`).set(rec.auth)).body.data.logoUrl).toBeNull();
    expect(fakeStorage.files.size).toBe(0);
    expect(JSON.stringify(second.body)).not.toContain("logoPublicId");
  });

  it("shows on the public recruiter card and on the captain of their requests; only recruiters can set it", async () => {
    const rec = await recruiterUser(w);
    await logo(rec.auth);
    await makeRequest(w, rec.user.id);
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const card = (await api().get(`${V1}/recruiters/${rec.recruiterId}`).set(p.auth)).body.data;
    expect(card.logoUrl).toBeTruthy();
    const feed = (await api().get(`${V1}/requests`).set(p.auth)).body.data;
    expect(feed[0].captain.logoUrl).toBe(card.logoUrl);
    expect((await logo(p.auth)).status).toBe(403);
    expect((await api().put(`${V1}/recruiters/me/logo`).attach("file", JPEG, { filename: "l.jpg", contentType: "image/jpeg" })).status).toBe(401);
    const noProfile = await signedIn("np@example.com");
    await prisma.user.update({ where: { id: noProfile.user.id }, data: { role: "RECRUITER" } });
    expect((await logo(noProfile.auth)).status).toBe(404);
  });

  it("an admin sees it on the user and can remove it (audited, file deleted); account deletion removes it too; it survives the orphan sweep", async () => {
    const admin = await adminUser();
    const rec = await recruiterUser(w);
    await logo(rec.auth);
    const detail = (await api().get(`${V1}/admin/users/${rec.user.id}`).set(admin.auth)).body.data;
    expect(detail.recruiter.logoUrl).toBeTruthy();
    const { sweepOrphanUploads } = await import("../src/modules/maintenance/sweep-orphan-uploads.js");
    const id = (await prisma.recruiterProfile.findFirstOrThrow()).logoPublicId!;
    fakeStorage.files.get(id)!.createdAt = new Date(Date.now() - 72 * 3_600_000);
    await sweepOrphanUploads();
    expect(fakeStorage.files.has(id)).toBe(true);
    expect((await api().delete(`${V1}/admin/users/${rec.user.id}/logo`).set(admin.auth).send({ reason: "Not their logo" })).status).toBe(200);
    expect(fakeStorage.files.has(id)).toBe(false);
    expect(await prisma.adminAction.count({ where: { action: "MEDIA_REMOVE" } })).toBe(1);

    await logo(rec.auth);
    await api().delete(`${V1}/auth/account`).set(rec.auth).send({ confirm: "DELETE", password: "Passw0rd1" });
    expect(fakeStorage.files.size).toBe(0);
  });
});

describe("profile views", () => {
  const view = (a: Record<string, string>, profileId: string) => api().get(`${V1}/players/${profileId}`).set(a);
  const day = (n: number) => () => new Date(realNow().getTime() + n * 86_400_000);

  it("counts a recruiter once per day per player, again the next Dhaka day, and tells the player the first time each day", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    await prisma.user.update({ where: { id: p.user.id }, data: { locale: "en" } });
    await prisma.deviceToken.create({ data: { userId: p.user.id, token: "fcm-view-".padEnd(30, "x"), platform: "ANDROID" } });
    const rec = await recruiterUser(w);
    await view(rec.auth, p.profileId);
    await view(rec.auth, p.profileId);
    await view(rec.auth, p.profileId);
    await settle();
    expect(await prisma.profileView.count()).toBe(1);
    expect(await prisma.notification.count({ where: { type: "PROFILE_VIEWED" } })).toBe(1);
    expect(fakePush.sent.filter((s) => s.message.title === "A recruiter viewed your profile")).toHaveLength(1);

    clock.now = day(1);
    await view(rec.auth, p.profileId);
    await settle();
    expect(await prisma.profileView.count()).toBe(2);
    expect(await prisma.notification.count({ where: { type: "PROFILE_VIEWED" } })).toBe(2);

    const other = await recruiterUser(w, "other@example.com");
    await view(other.auth, p.profileId);
    expect(await prisma.profileView.count()).toBe(3);
  });

  it("never records players, the owner, or signed-out visitors", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const other = await playerUser(w, "q@example.com", [{ sportId: w.football.id }]);
    await view(other.auth, p.profileId);
    await view(p.auth, p.profileId);
    await api().get(`${V1}/public/players/${p.profileId}`);
    expect(await prisma.profileView.count()).toBe(0);
  });

  it("lists who viewed me (players only, mine only), and the notification honours the player's switch", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const stranger = await playerUser(w, "s@example.com", [{ sportId: w.football.id }]);
    await prisma.deviceToken.create({ data: { userId: p.user.id, token: "fcm-view2-".padEnd(30, "x"), platform: "ANDROID" } });
    const rec = await recruiterUser(w);
    expect((await api().put(`${V1}/notifications/preferences`).set(p.auth).send({ profileViewed: false })).body.data.profileViewed).toBe(false);
    await view(rec.auth, p.profileId);
    await settle();
    expect(fakePush.sent).toHaveLength(0);
    expect(await prisma.pushJob.findFirstOrThrow({ where: { type: "PROFILE_VIEWED" } })).toMatchObject({ status: "SKIPPED", skipReason: "CATEGORY_OFF" });
    expect(await prisma.notification.count({ where: { type: "PROFILE_VIEWED" } })).toBe(1); // the inbox still keeps it

    const mine = (await api().get(`${V1}/players/me/profile-views`).set(p.auth)).body.data;
    expect(mine).toEqual([expect.objectContaining({ viewer: expect.objectContaining({ recruiterId: rec.recruiterId, organization: "Barishal United" }) })]);
    expect((await api().get(`${V1}/players/me/profile-views`).set(stranger.auth)).body.data).toEqual([]);
    expect((await api().get(`${V1}/players/me/profile-views`).set(rec.auth)).status).toBe(403);
  });
});
