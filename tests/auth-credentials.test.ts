import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER, V1, api, bearer, login, prisma, registerUser, resetDb } from "./helpers.js";
import { lastCode, mailsTo } from "./mailbox.js";

beforeEach(resetDb);

describe("register", () => {
  it("creates the user, signs them in, and emails a verification code", async () => {
    const res = await api().post(`${V1}/auth/register`).send({ ...DEFAULT_USER, email: "  Rakib@Example.COM " });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      email: "rakib@example.com", // trimmed + lower-cased
      emailVerified: false,
      hasPassword: true,
      loginMethods: ["EMAIL"],
      role: "USER",
      locale: "bn",
    });
    expect(res.body.data.tokens).toMatchObject({ tokenType: "Bearer", expiresIn: 900 });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    expect(mailsTo("rakib@example.com")).toHaveLength(1);
    expect(lastCode("rakib@example.com")).toMatch(/^\d{6}$/);

    const row = await prisma.user.findUniqueOrThrow({ where: { email: "rakib@example.com" } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("stores only a hash of the refresh token", async () => {
    const { refreshToken } = await registerUser();
    const rows = await prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(refreshToken);
    expect(JSON.stringify(rows)).not.toContain(refreshToken);
  });

  it("rejects a duplicate email regardless of case with AUTH_EMAIL_TAKEN", async () => {
    await registerUser();
    const res = await api().post(`${V1}/auth/register`).send({ ...DEFAULT_USER, email: "RAKIB@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_EMAIL_TAKEN");
  });

  it.each([
    ["too short", "Ab1"],
    ["no digit", "OnlyLetters"],
    ["no letter", "12345678"],
  ])("rejects a weak password (%s)", async (_label, password) => {
    const res = await api().post(`${V1}/auth/register`).send({ ...DEFAULT_USER, password });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("email verification", () => {
  it("verifies with the right code, and the code works only once", async () => {
    const { user } = await registerUser();
    const code = lastCode(DEFAULT_USER.email);

    const ok = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ verified: true, alreadyVerified: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();

    const replay = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("AUTH_INVALID_OTP");
  });

  it("rejects a wrong code", async () => {
    await registerUser();
    const wrong = lastCode(DEFAULT_USER.email) === "000000" ? "111111" : "000000";
    const res = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: wrong });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AUTH_INVALID_OTP");
  });

  it("locks the code after 5 wrong guesses — even the right code is then refused", async () => {
    await registerUser();
    const right = lastCode(DEFAULT_USER.email);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: wrong });
      expect(r.body.error.code).toBe("AUTH_INVALID_OTP");
    }
    const res = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: right });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("AUTH_OTP_TOO_MANY_ATTEMPTS");
  });

  it("rejects an expired code with AUTH_OTP_EXPIRED", async () => {
    await registerUser();
    await prisma.verificationCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: lastCode(DEFAULT_USER.email) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AUTH_OTP_EXPIRED");
  });

  it("rate-limits resend with a cooldown, then a new code invalidates the old one", async () => {
    const { accessToken } = await registerUser();
    const first = lastCode(DEFAULT_USER.email);

    const tooSoon = await api().post(`${V1}/auth/resend-verification`).set(bearer(accessToken));
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe("AUTH_OTP_COOLDOWN");

    await prisma.verificationCode.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    const resend = await api().post(`${V1}/auth/resend-verification`).set(bearer(accessToken));
    expect(resend.status).toBe(200);
    expect(mailsTo(DEFAULT_USER.email)).toHaveLength(2);

    const second = lastCode(DEFAULT_USER.email);
    if (second !== first) {
      const old = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: first });
      expect(old.status).toBe(400);
    }
    const ok = await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: second });
    expect(ok.status).toBe(200);
  });

  it("refuses to resend once verified", async () => {
    const { accessToken } = await registerUser();
    await api().post(`${V1}/auth/verify-email`).send({ email: DEFAULT_USER.email, code: lastCode(DEFAULT_USER.email) });
    const res = await api().post(`${V1}/auth/resend-verification`).set(bearer(accessToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_EMAIL_ALREADY_VERIFIED");
  });
});

describe("login", () => {
  it("logs in with the right password (email is case-insensitive)", async () => {
    await registerUser();
    const res = await login("RAKIB@example.com");
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("rakib@example.com");
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });

  it("answers wrong password and unknown email identically (no account oracle)", async () => {
    await registerUser();
    const wrong = await login(DEFAULT_USER.email, "Wr0ngPassword");
    const unknown = await login("nobody@example.com", "Wr0ngPassword");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("tells a suspended user so only after they prove the password", async () => {
    const { user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });

    const good = await login();
    expect(good.status).toBe(403);
    expect(good.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");

    const bad = await login(DEFAULT_USER.email, "Wr0ngPassword");
    expect(bad.status).toBe(401);
  });

  it("does not let a social-only account log in with a password", async () => {
    await prisma.user.create({ data: { name: "S", email: "social@example.com" } });
    const res = await login("social@example.com", "Passw0rd1");
    expect(res.status).toBe(401);
  });
});

describe("access-token guard (GET /auth/methods)", () => {
  const protectedCall = (token?: string) => {
    const r = api().get(`${V1}/auth/methods`);
    return token ? r.set(bearer(token)) : r;
  };

  it("accepts a valid token and never trusts client-sent ids", async () => {
    const { accessToken, user } = await registerUser();
    const res = await protectedCall(accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(user.id);
  });

  it("rejects missing and malformed tokens with AUTH_UNAUTHENTICATED", async () => {
    expect((await protectedCall()).body.error.code).toBe("AUTH_UNAUTHENTICATED");
    expect((await protectedCall("garbage")).body.error.code).toBe("AUTH_UNAUTHENTICATED");
  });

  it("distinguishes an expired token so the app knows to refresh", async () => {
    const { user } = await registerUser();
    const expired = await new SignJWT({ role: "USER" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("playerhaat-api")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
    const res = await protectedCall(expired);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_TOKEN_EXPIRED");
  });

  it("rejects a token signed with another key", async () => {
    const { user } = await registerUser();
    const forged = await new SignJWT({ role: "ADMIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("playerhaat-api")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("another-secret-another-secret-another-1"));
    expect((await protectedCall(forged)).status).toBe(401);
  });

  it("takes effect immediately when the user is suspended or deleted", async () => {
    const { accessToken, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    const suspended = await protectedCall(accessToken);
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");

    await prisma.user.update({ where: { id: user.id }, data: { status: "DELETED" } });
    expect((await protectedCall(accessToken)).status).toBe(401);
  });

  it("reads the role from the DB, not the token", async () => {
    const { accessToken, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await protectedCall(accessToken)).body.data.role).toBe("ADMIN");
  });
});
