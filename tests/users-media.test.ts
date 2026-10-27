import { beforeEach, describe, expect, it } from "vitest";
import { fakeStorage } from "./fake-storage.js";
import { DEFAULT_USER, V1, api, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";
import { HEIC, JPEG, NOT_AN_IMAGE, PNG, WEBP, bigImage } from "./images.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const patchMe = (auth: Record<string, string>, body: object) => api().patch(`${V1}/users/me`).set(auth).send(body);
const putAvatar = (auth: Record<string, string>, buf: Buffer, contentType = "image/jpeg") =>
  api().put(`${V1}/users/me/avatar`).set(auth).attach("file", buf, { filename: "a.jpg", contentType });
const upload = (auth: Record<string, string>, buf: Buffer, type = "player-photo", contentType = "image/jpeg") =>
  api().post(`${V1}/media/images`).set(auth).field("type", type).attach("file", buf, { filename: "p.jpg", contentType });

describe("GET /users/me", () => {
  it("returns my account without secrets, and flags whether I have a player profile", async () => {
    const { auth, user } = await signedIn();
    const before = await api().get(`${V1}/users/me`).set(auth);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      id: user.id,
      email: "viewer@example.com",
      emailVerified: false,
      phoneVerified: false,
      hasPlayerProfile: false,
      captainRating: { average: 0, count: 0 },
      locale: "bn",
      role: "PLAYER",
    });
    expect(JSON.stringify(before.body)).not.toMatch(/passwordHash|avatarPublicId/);

    await prisma.playerProfile.create({ data: { userId: user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    expect((await api().get(`${V1}/users/me`).set(auth)).body.data.hasPlayerProfile).toBe(true);
  });

  it("requires authentication", async () => {
    expect((await api().get(`${V1}/users/me`)).status).toBe(401);
  });
});

describe("PATCH /users/me", () => {
  it("updates name, birth year and locale", async () => {
    const { auth } = await signedIn();
    const res = await patchMe(auth, { name: "  Rakib H.  ", birthYear: 2001, locale: "en" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Rakib H.", birthYear: 2001, locale: "en" });
  });

  it("rejects an empty body, a bad birth year and a bad locale", async () => {
    const { auth } = await signedIn();
    expect((await patchMe(auth, {})).status).toBe(422);
    expect((await patchMe(auth, { birthYear: new Date().getFullYear() })).status).toBe(422);
    expect((await patchMe(auth, { birthYear: 1800 })).status).toBe(422);
    expect((await patchMe(auth, { locale: "fr" })).status).toBe(422);
    expect((await patchMe(auth, { name: "   " })).status).toBe(422);
  });

  it("refuses to change protected fields (no mass assignment)", async () => {
    const { auth, user } = await signedIn();
    for (const body of [{ role: "ADMIN" }, { status: "ACTIVE" }, { email: "x@y.com" }, { passwordHash: "x" }, { captainAvgRating: 5 }]) {
      const res = await patchMe(auth, { name: "Ok", ...body });
      expect(res.status).toBe(422);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ role: "PLAYER", email: "viewer@example.com", name: "Viewer", captainAvgRating: 0 });
  });

  it("normalizes the phone to E.164, stores it unverified, and can clear it", async () => {
    const { auth } = await signedIn();
    const set = await patchMe(auth, { phone: "01712-345678" });
    expect(set.body.data).toMatchObject({ phone: "+8801712345678", phoneVerified: false });
    const cleared = await patchMe(auth, { phone: null });
    expect(cleared.body.data.phone).toBeNull();
  });

  it("rejects an invalid phone and a number another user holds", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    expect((await patchMe(a.auth, { phone: "12345" })).status).toBe(422);
    await patchMe(a.auth, { phone: "01712345678" });
    const dup = await patchMe(b.auth, { phone: "+8801712345678" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("USER_PHONE_TAKEN");
  });
});

describe("avatar", () => {
  it("uploads into my own folder and stores the url + public id", async () => {
    const { auth, user } = await signedIn();
    const res = await putAvatar(auth, JPEG);
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.avatarUrl).toBe(res.body.data.avatarUrl);
    expect(row.avatarPublicId).toContain(`/avatars/${user.id}/`);
    expect(fakeStorage.files.get(row.avatarPublicId!)?.kind).toBe("avatar");
  });

  it("replaces the old avatar and deletes it from storage", async () => {
    const { auth, user } = await signedIn();
    await putAvatar(auth, JPEG);
    const first = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId!;
    await putAvatar(auth, PNG, "image/png");
    const second = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId!;
    expect(second).not.toBe(first);
    expect(fakeStorage.files.has(first)).toBe(false);
    expect(fakeStorage.files.has(second)).toBe(true);
    expect(fakeStorage.deleted).toContain(first);
  });

  it.each([
    ["webp", WEBP, "image/webp"],
    ["heic", HEIC, "image/heic"],
  ])("accepts %s", async (_n, buf, type) => {
    const { auth } = await signedIn();
    expect((await putAvatar(auth, buf, type)).status).toBe(200);
  });

  it("removes the avatar and deletes the stored file", async () => {
    const { auth, user } = await signedIn();
    await putAvatar(auth, JPEG);
    const id = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId!;
    const res = await api().delete(`${V1}/users/me/avatar`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
    expect(fakeStorage.files.has(id)).toBe(false);
  });

  it("rejects a non-image declared type, spoofed content, oversize files and a missing file", async () => {
    const { auth } = await signedIn();
    const wrongType = await putAvatar(auth, JPEG, "application/pdf");
    expect(wrongType.status).toBe(415);
    expect(wrongType.body.error.code).toBe("MEDIA_UNSUPPORTED_TYPE");

    const spoofed = await putAvatar(auth, NOT_AN_IMAGE, "image/jpeg"); // claims jpeg, is a PHP script
    expect(spoofed.status).toBe(415);

    const tooBig = await putAvatar(auth, bigImage(5 * 1024 * 1024 + 1024));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe("MEDIA_TOO_LARGE");

    const none = await api().put(`${V1}/users/me/avatar`).set(auth).field("x", "y");
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe("MEDIA_FILE_REQUIRED");

    expect(fakeStorage.files.size).toBe(0); // nothing reached storage
  });

  it("accepts a file just under the limit", async () => {
    const { auth } = await signedIn();
    expect((await putAvatar(auth, bigImage(5 * 1024 * 1024 - 1024))).status).toBe(200);
  });

  it("surfaces a storage failure as 502 and leaves the avatar unchanged", async () => {
    const { auth, user } = await signedIn();
    await putAvatar(auth, JPEG);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId;
    fakeStorage.failUploads = true;
    const res = await putAvatar(auth, PNG, "image/png");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("STORAGE_UPLOAD_FAILED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId).toBe(before);
  });

  it("still succeeds if deleting the old file fails (logged, not thrown)", async () => {
    const { auth } = await signedIn();
    await putAvatar(auth, JPEG);
    fakeStorage.failDeletes = true;
    expect((await putAvatar(auth, PNG, "image/png")).status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await api().put(`${V1}/users/me/avatar`).attach("file", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });
});

describe("POST /media/images", () => {
  it("uploads under the caller's namespace and returns url + publicId", async () => {
    const { auth, user } = await signedIn();
    const res = await upload(auth, JPEG, "team-logo");
    expect(res.status).toBe(201);
    expect(res.body.data.publicId).toContain(`/team-logos/${user.id}/`);
    expect(res.body.data.url).toBe(`https://fake.cdn/${res.body.data.publicId}`);
    expect(fakeStorage.files.get(res.body.data.publicId)?.kind).toBe("team-logo");
  });

  it("uses a separate folder per type", async () => {
    const { auth } = await signedIn();
    const a = (await upload(auth, JPEG, "avatar")).body.data.publicId as string;
    const p = (await upload(auth, JPEG, "player-photo")).body.data.publicId as string;
    expect(a).toContain("/avatars/");
    expect(p).toContain("/player-photos/");
  });

  it("rejects an unknown type", async () => {
    const { auth } = await signedIn();
    expect((await upload(auth, JPEG, "banner")).status).toBe(422);
  });

  it("deletes my own unattached upload", async () => {
    const { auth } = await signedIn();
    const id = (await upload(auth, JPEG)).body.data.publicId as string;
    const res = await api().delete(`${V1}/media/images`).set(auth).send({ publicId: id });
    expect(res.status).toBe(200);
    expect(fakeStorage.files.has(id)).toBe(false);
  });

  it("will not delete someone else's image", async () => {
    const owner = await signedIn("owner@example.com");
    const other = await signedIn("other@example.com");
    const id = (await upload(owner.auth, JPEG)).body.data.publicId as string;
    const res = await api().delete(`${V1}/media/images`).set(other.auth).send({ publicId: id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MEDIA_NOT_OWNED");
    expect(fakeStorage.files.has(id)).toBe(true);
  });

  it("will not delete an image that is still my avatar", async () => {
    const { auth, user } = await signedIn();
    await putAvatar(auth, JPEG);
    const id = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId!;
    const res = await api().delete(`${V1}/media/images`).set(auth).send({ publicId: id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MEDIA_IN_USE");
    expect(fakeStorage.files.has(id)).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await api().post(`${V1}/media/images`).field("type", "avatar").attach("file", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /users/me", () => {
  it("is the same deletion as /auth/account and purges every stored image", async () => {
    const { auth, user } = await signedIn("viewer@example.com");
    await putAvatar(auth, JPEG);
    const profile = await prisma.playerProfile.create({ data: { userId: user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    const photo = (await upload(auth, JPEG, "player-photo")).body.data.publicId as string;
    await prisma.playerMedia.create({ data: { profileId: profile.id, type: "PHOTO", url: "u", publicId: photo } });
    const avatarId = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).avatarPublicId!;

    const res = await api().delete(`${V1}/users/me`).set(auth).send({ confirm: "DELETE", password: DEFAULT_USER.password });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("DELETED");
    expect(fakeStorage.files.has(avatarId)).toBe(false);
    expect(fakeStorage.files.has(photo)).toBe(false);
    expect(fakeStorage.files.size).toBe(0);
  });

  it("needs the confirmation literal", async () => {
    const { auth } = await signedIn();
    expect((await api().delete(`${V1}/users/me`).set(auth).send({ password: DEFAULT_USER.password })).status).toBe(422);
  });
});

