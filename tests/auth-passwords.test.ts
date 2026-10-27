import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER, V1, api, bearer, login, prisma, registerUser, resetDb } from "./helpers.js";
import { lastCode, mailbox, mailsTo } from "./mailbox.js";

beforeEach(resetDb);

const forgot = (email = DEFAULT_USER.email) => api().post(`${V1}/auth/forgot-password`).send({ email });
const reset = (code: string, newPassword = "N3wPassword", email = DEFAULT_USER.email) =>
  api().post(`${V1}/auth/reset-password`).send({ email, code, newPassword });

describe("forgot / reset password", () => {
  it("answers the same for registered and unknown emails, and only mails the registered one", async () => {
    await registerUser();
    mailbox.length = 0;
    const known = await forgot();
    const unknown = await forgot("nobody@example.com");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(mailsTo(DEFAULT_USER.email)).toHaveLength(1);
    expect(mailsTo("nobody@example.com")).toHaveLength(0);
  });

  it("silently ignores repeat requests inside the cooldown (one email, same 200)", async () => {
    await registerUser();
    mailbox.length = 0;
    await forgot();
    const again = await forgot();
    expect(again.status).toBe(200);
    expect(mailsTo(DEFAULT_USER.email)).toHaveLength(1);
  });

  it("resets the password, revokes every session, and marks the email verified", async () => {
    const { refreshToken, user } = await registerUser();
    await forgot();
    const res = await reset(lastCode(DEFAULT_USER.email));
    expect(res.status).toBe(200);

    expect((await login(DEFAULT_USER.email, DEFAULT_USER.password)).status).toBe(401); // old password dead
    expect((await login(DEFAULT_USER.email, "N3wPassword")).status).toBe(200);
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken })).status).toBe(401); // old session dead
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
  });

  it("uses each reset code once", async () => {
    await registerUser();
    await forgot();
    const code = lastCode(DEFAULT_USER.email);
    expect((await reset(code)).status).toBe(200);
    const replay = await reset(code, "An0therPass");
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("AUTH_INVALID_OTP");
  });

  it("does not accept an email-verification code as a reset code", async () => {
    await registerUser();
    const verifyCode = lastCode(DEFAULT_USER.email);
    const res = await reset(verifyCode);
    expect(res.status).toBe(400);
  });

  it("rejects a wrong code, a weak new password, and unknown emails", async () => {
    await registerUser();
    await forgot();
    const right = lastCode(DEFAULT_USER.email);
    const wrong = right === "000000" ? "111111" : "000000";
    expect((await reset(wrong)).body.error.code).toBe("AUTH_INVALID_OTP");
    expect((await reset(right, "short")).status).toBe(422);
    expect((await reset(right, "N3wPassword", "nobody@example.com")).body.error.code).toBe("AUTH_INVALID_OTP");
  });

  it("lets a social-only user create a password through reset", async () => {
    await prisma.user.create({ data: { name: "S", email: "s@example.com", emailVerifiedAt: new Date() } });
    await forgot("s@example.com");
    expect((await reset(lastCode("s@example.com"), "N3wPassword", "s@example.com")).status).toBe(200);
    const res = await login("s@example.com", "N3wPassword");
    expect(res.status).toBe(200);
    expect(res.body.data.user.loginMethods).toEqual(["EMAIL"]);
  });
});

describe("PUT /auth/password", () => {
  const put = (token: string, body: object) => api().put(`${V1}/auth/password`).set(bearer(token)).send(body);

  it("changes the password with the current one, revoking old sessions and returning working tokens", async () => {
    const { accessToken, refreshToken } = await registerUser();
    const res = await put(accessToken, { currentPassword: DEFAULT_USER.password, newPassword: "N3wPassword" });
    expect(res.status).toBe(200);

    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken })).status).toBe(401);
    const fresh = await api().post(`${V1}/auth/refresh`).send({ refreshToken: res.body.data.tokens.refreshToken });
    expect(fresh.status).toBe(200);
    expect((await login(DEFAULT_USER.email, "N3wPassword")).status).toBe(200);
  });

  it("requires the current password when one exists, and checks it", async () => {
    const { accessToken } = await registerUser();
    expect((await put(accessToken, { newPassword: "N3wPassword" })).body.error.code).toBe("AUTH_PASSWORD_REQUIRED");
    expect((await put(accessToken, { currentPassword: "Wr0ngPassword", newPassword: "N3wPassword" })).body.error.code).toBe(
      "AUTH_WRONG_PASSWORD",
    );
  });

  it("lets a social-only user add a password without a current one", async () => {
    const social = await api()
      .post(`${V1}/auth/google`)
      .send({ idToken: (await import("./fake-social.js")).fakeToken({ providerUserId: "g1", email: "g@example.com" }) });
    const token = social.body.data.tokens.accessToken as string;
    const res = await put(token, { newPassword: "N3wPassword" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.loginMethods.sort()).toEqual(["EMAIL", "GOOGLE"]);
    expect((await login("g@example.com", "N3wPassword")).status).toBe(200);
  });

  it("refuses when the account has no email to attach a password to", async () => {
    const social = await api()
      .post(`${V1}/auth/apple`)
      .send({ identityToken: (await import("./fake-social.js")).fakeToken({ providerUserId: "a1", emailVerified: false }) });
    const res = await put(social.body.data.tokens.accessToken, { newPassword: "N3wPassword" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_NO_EMAIL");
  });
});
