import { beforeEach, describe, expect, it } from "vitest";
import { fakeToken } from "./fake-social.js";
import { DEFAULT_USER, V1, api, bearer, login, prisma, registerUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

const asUser = (token: string) => ({
  get: (path: string) => api().get(`${V1}${path}`).set(bearer(token)),
  post: (path: string, body?: object) => api().post(`${V1}${path}`).set(bearer(token)).send(body),
  del: (path: string, body?: object) => api().delete(`${V1}${path}`).set(bearer(token)).send(body),
});

describe("login methods", () => {
  it("lists the methods on the account", async () => {
    const { accessToken } = await registerUser();
    const res = await asUser(accessToken).get("/auth/methods");
    expect(res.body.data).toMatchObject({ loginMethods: ["EMAIL"], hasPassword: true });
  });

  it("links Google to the signed-in user", async () => {
    const { accessToken } = await registerUser();
    const res = await asUser(accessToken).post("/auth/methods/google", {
      idToken: fakeToken({ providerUserId: "g-1", email: "other@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.loginMethods.sort()).toEqual(["EMAIL", "GOOGLE"]);
    expect(res.body.data.email).toBe(DEFAULT_USER.email); // existing email is never replaced
  });

  it("linking is idempotent for the same user", async () => {
    const { accessToken } = await registerUser();
    const body = { idToken: fakeToken({ providerUserId: "g-1" }) };
    expect((await asUser(accessToken).post("/auth/methods/google", body)).status).toBe(200);
    const again = await asUser(accessToken).post("/auth/methods/google", body);
    expect(again.status).toBe(200);
    expect(await prisma.authAccount.count({ where: { provider: "GOOGLE" } })).toBe(1);
  });

  it("refuses to link a provider identity that already belongs to someone else", async () => {
    await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-taken", email: "a@example.com" }) });
    const { accessToken } = await registerUser();
    const res = await asUser(accessToken).post("/auth/methods/google", { idToken: fakeToken({ providerUserId: "g-taken" }) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_PROVIDER_ALREADY_LINKED");
  });

  it("fills in and verifies the email from a verified provider email", async () => {
    const apple = await api().post(`${V1}/auth/apple`).send({ identityToken: fakeToken({ providerUserId: "a-1", emailVerified: false }) });
    const res = await asUser(apple.body.data.tokens.accessToken).post("/auth/methods/google", {
      idToken: fakeToken({ providerUserId: "g-1", email: "new@example.com" }),
    });
    expect(res.body.data).toMatchObject({ email: "new@example.com", emailVerified: true });
  });

  it("never removes the last login method", async () => {
    const { accessToken } = await registerUser();
    const res = await asUser(accessToken).del("/auth/methods/EMAIL");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_LAST_LOGIN_METHOD");
    expect((await login()).status).toBe(200);
  });

  it("removes a method when another remains; removing EMAIL also drops the password", async () => {
    const { accessToken } = await registerUser();
    await asUser(accessToken).post("/auth/methods/google", { idToken: fakeToken({ providerUserId: "g-1" }) });

    const res = await asUser(accessToken).del("/auth/methods/EMAIL");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ loginMethods: ["GOOGLE"], hasPassword: false });
    expect((await login()).status).toBe(401);
  });

  it("two concurrent removals can't strip both methods", async () => {
    const { accessToken } = await registerUser();
    await asUser(accessToken).post("/auth/methods/google", { idToken: fakeToken({ providerUserId: "g-1" }) });
    const [a, b] = await Promise.all([asUser(accessToken).del("/auth/methods/EMAIL"), asUser(accessToken).del("/auth/methods/GOOGLE")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.authAccount.count()).toBe(1);
  });

  it("404s when removing a method that isn't linked, and 422s on an unknown provider", async () => {
    const { accessToken } = await registerUser();
    expect((await asUser(accessToken).del("/auth/methods/APPLE")).body.error.code).toBe("AUTH_PROVIDER_NOT_LINKED");
    expect((await asUser(accessToken).del("/auth/methods/FACEBOOK")).status).toBe(422);
  });
});

describe("account deletion", () => {
  const del = (token: string, body: object) => asUser(token).del("/auth/account", body);

  it("requires the literal confirmation and the password", async () => {
    const { accessToken } = await registerUser();
    expect((await del(accessToken, { password: DEFAULT_USER.password })).status).toBe(422);
    expect((await del(accessToken, { password: DEFAULT_USER.password, confirm: "yes" })).status).toBe(422);
    expect((await del(accessToken, { confirm: "DELETE" })).body.error.code).toBe("AUTH_PASSWORD_REQUIRED");
    expect((await del(accessToken, { confirm: "DELETE", password: "Wr0ngPassword" })).body.error.code).toBe("AUTH_WRONG_PASSWORD");
    expect((await prisma.user.findFirstOrThrow()).status).toBe("ACTIVE");
  });

  it("anonymizes the user, removes credentials, and revokes every session", async () => {
    const { accessToken, refreshToken, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { phone: "+8801712345678", birthYear: 1999, avatarUrl: "https://x/a.png", avatarPublicId: "a1" } });
    await prisma.deviceToken.create({ data: { userId: user.id, token: "fcm-1", platform: "ANDROID" } });
    await prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", data: {} } });

    const res = await del(accessToken, { confirm: "DELETE", password: DEFAULT_USER.password });
    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { authAccounts: true } });
    expect(row).toMatchObject({
      status: "DELETED",
      name: "Deleted user",
      email: null,
      phone: null,
      passwordHash: null,
      avatarUrl: null,
      avatarPublicId: null,
      birthYear: null,
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.authAccounts).toHaveLength(0);
    expect(await prisma.deviceToken.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.verificationCode.count()).toBe(0);

    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken })).status).toBe(401);
    expect((await asUser(accessToken).get("/auth/methods")).status).toBe(401); // live access token dies at once
    expect((await login()).status).toBe(401);
  });

  it("lets a social-only user delete without a password", async () => {
    const g = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-1", email: "g@example.com" }) });
    const res = await del(g.body.data.tokens.accessToken, { confirm: "DELETE" });
    expect(res.status).toBe(200);
    // the Google identity is gone too, so signing in again creates a brand-new account
    const again = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-1", email: "g@example.com" }) });
    expect(again.body.data.user.id).not.toBe(g.body.data.user.id);
  });

  it("frees the email for a fresh registration", async () => {
    const first = await registerUser();
    await del(first.accessToken, { confirm: "DELETE", password: DEFAULT_USER.password });
    const second = await registerUser();
    expect(second.user.id).not.toBe(first.user.id);
  });

  it("withdraws pending applications, cancels upcoming requests, hides the profile, and drops media", async () => {
    const { accessToken, user } = await registerUser();
    const other = await registerUser({ email: "captain@example.com", name: "Captain" });

    const division = await prisma.division.create({ data: { slug: "d", nameEn: "D", nameBn: "ড" } });
    const district = await prisma.district.create({ data: { divisionId: division.id, slug: "x", nameEn: "X", nameBn: "ক" } });
    const upazila = await prisma.upazila.create({ data: { districtId: district.id, slug: "u", nameEn: "U", nameBn: "খ" } });
    const sport = await prisma.sport.create({ data: { code: "FOOTBALL", nameEn: "Football", nameBn: "ফুটবল" } });
    const loc = { districtId: district.id, upazilaId: upazila.id, sportId: sport.id };
    const future = new Date(Date.now() + 86_400_000);

    const mine = await prisma.playerRequest.create({ data: { createdById: user.id, ...loc, matchAt: future, venueText: "v" } });
    const past = await prisma.playerRequest.create({
      data: { createdById: user.id, ...loc, matchAt: new Date(Date.now() - 86_400_000), venueText: "old", status: "COMPLETED" },
    });
    const theirs = await prisma.playerRequest.create({ data: { createdById: other.user.id, ...loc, matchAt: future, venueText: "w" } });
    await prisma.application.create({ data: { requestId: theirs.id, playerId: user.id } });

    const profile = await prisma.playerProfile.create({
      data: { userId: user.id, bio: "hello", districtId: district.id, upazilaId: upazila.id },
    });
    await prisma.playerMedia.create({ data: { profileId: profile.id, type: "PHOTO", url: "https://x/1.jpg", publicId: "pid-1" } });

    await del(accessToken, { confirm: "DELETE", password: DEFAULT_USER.password });

    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("CANCELLED");
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: past.id } })).status).toBe("COMPLETED"); // history kept
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("OPEN"); // others untouched
    expect((await prisma.application.findFirstOrThrow()).status).toBe("WITHDRAWN");
    expect(await prisma.playerProfile.findUniqueOrThrow({ where: { id: profile.id } })).toMatchObject({ isVisible: false, bio: null });
    expect(await prisma.playerMedia.count()).toBe(0);
  });

  it("requires authentication", async () => {
    expect((await api().delete(`${V1}/auth/account`).send({ confirm: "DELETE" })).status).toBe(401);
  });
});
