import { beforeEach, describe, expect, it } from "vitest";
import { fakeToken } from "./fake-social.js";
import { DEFAULT_USER, V1, api, login, prisma, registerUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

const google = (p: Parameters<typeof fakeToken>[0]) => api().post(`${V1}/auth/google`).send({ idToken: fakeToken(p) });
const apple = (p: Parameters<typeof fakeToken>[0], extra: object = {}) =>
  api().post(`${V1}/auth/apple`).send({ identityToken: fakeToken(p), ...extra });

describe("Google sign-in", () => {
  it("creates a verified user on first login and reuses it afterwards", async () => {
    const first = await google({ providerUserId: "g-1", email: "Sara@Example.com", name: "Sara Khan", picture: "https://x/p.png" });
    expect(first.status).toBe(200);
    expect(first.body.data.user).toMatchObject({
      name: "Sara Khan",
      email: "sara@example.com",
      emailVerified: true,
      hasPassword: false,
      loginMethods: ["GOOGLE"],
      avatarUrl: "https://x/p.png",
    });

    const second = await google({ providerUserId: "g-1", email: "sara@example.com" });
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("links to an existing account when the verified email matches", async () => {
    const { user } = await registerUser();
    await api().post(`${V1}/auth/verify-email`).send({
      email: DEFAULT_USER.email,
      code: (await import("./mailbox.js")).lastCode(DEFAULT_USER.email),
    });

    const res = await google({ providerUserId: "g-9", email: DEFAULT_USER.email });
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user.loginMethods.sort()).toEqual(["EMAIL", "GOOGLE"]);
    expect((await login()).status).toBe(200); // password still works: owner proved the email first
  });

  it("does not link on an unverified provider email — it creates a separate user without that email", async () => {
    await registerUser();
    const res = await google({ providerUserId: "g-2", email: DEFAULT_USER.email, emailVerified: false });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).not.toBe((await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_USER.email } })).id);
    expect(res.body.data.user.email).toBeNull();
    expect(await prisma.user.count()).toBe(2);
  });

  it("defeats pre-hijacking: a password planted on an unverified email dies when the real owner signs in via Google", async () => {
    // Attacker registers the victim's address (never verifies it) and keeps a session.
    const attacker = await registerUser({ email: "victim@example.com", password: "Attack3rPass" });

    const victim = await google({ providerUserId: "g-victim", email: "victim@example.com" });
    expect(victim.status).toBe(200);
    expect(victim.body.data.user.id).toBe(attacker.user.id); // same account, now owned by the real person
    expect(victim.body.data.user).toMatchObject({ emailVerified: true, hasPassword: false, loginMethods: ["GOOGLE"] });

    expect((await login("victim@example.com", "Attack3rPass")).status).toBe(401); // planted password dead
    const stolen = await api().post(`${V1}/auth/refresh`).send({ refreshToken: attacker.refreshToken });
    expect(stolen.status).toBe(401); // planted session dead
  });

  it("rejects an invalid token and a suspended user", async () => {
    const bad = await api().post(`${V1}/auth/google`).send({ idToken: "not-a-real-google-token-at-all" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("AUTH_INVALID_SOCIAL_TOKEN");

    const ok = await google({ providerUserId: "g-3", email: "z@example.com" });
    await prisma.user.update({ where: { id: ok.body.data.user.id }, data: { status: "SUSPENDED" } });
    const res = await google({ providerUserId: "g-3", email: "z@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");
  });

  it("survives two first-time logins racing (one user, both succeed)", async () => {
    const p = { providerUserId: "g-race", email: "race@example.com", name: "Race" };
    const [a, b] = await Promise.all([google(p), google(p)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.user.id).toBe(b.body.data.user.id);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("Sign in with Apple", () => {
  it("stores the name from the first login (Apple only sends it once)", async () => {
    const first = await apple({ providerUserId: "a-1", email: "amir@example.com" }, { name: "Amir Hossain" });
    expect(first.body.data.user.name).toBe("Amir Hossain");

    // Second login: no name, and Apple may omit the email entirely. Same user, name preserved.
    const second = await apple({ providerUserId: "a-1" }, {});
    expect(second.status).toBe(200);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(second.body.data.user.name).toBe("Amir Hossain");
  });

  it("ignores a name sent later for an account that already exists", async () => {
    const first = await apple({ providerUserId: "a-2", email: "n@example.com" }, { name: "Original" });
    const second = await apple({ providerUserId: "a-2" }, { name: "Changed" });
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(second.body.data.user.name).toBe("Original");
  });

  it("accepts a private-relay email as a verified email", async () => {
    const res = await apple({ providerUserId: "a-3", email: "abc123@privaterelay.appleid.com" }, { name: "Relay User" });
    expect(res.body.data.user).toMatchObject({ email: "abc123@privaterelay.appleid.com", emailVerified: true });
  });

  it("creates an email-less user when Apple gives no verified email, with a fallback name", async () => {
    const res = await apple({ providerUserId: "a-4", emailVerified: false });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: null, name: "Player" });
  });

  it("links to an existing verified-email account", async () => {
    const g = await google({ providerUserId: "g-5", email: "both@example.com" });
    const a = await apple({ providerUserId: "a-5", email: "both@example.com" });
    expect(a.body.data.user.id).toBe(g.body.data.user.id);
    expect(a.body.data.user.loginMethods.sort()).toEqual(["APPLE", "GOOGLE"]);
  });

  it("rejects an invalid token", async () => {
    const res = await api().post(`${V1}/auth/apple`).send({ identityToken: "nope-nope-nope-nope-nope-nope" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_INVALID_SOCIAL_TOKEN");
  });
});
