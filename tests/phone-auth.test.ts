import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { fakeSms } from "./fake-sms.js";
import { DEFAULT_USER, V1, api, bearer, login, prisma, registerUser, resetDb, signedIn } from "./helpers.js";

const PHONE = "+8801712345678";
beforeEach(resetDb);

const requestCode = (phone = "01712345678") => api().post(`${V1}/auth/phone/request`).send({ phone });
const verify = (code: string, extra: object = {}, phone = "01712345678") => api().post(`${V1}/auth/phone/verify`).send({ phone, code, ...extra });
const backdateCodes = () => prisma.verificationCode.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });

describe("POST /auth/phone/request", () => {
  it("texts a 6-digit code to the normalized number", async () => {
    expect((await requestCode("017 1234-5678")).status).toBe(200);
    expect(fakeSms.sent).toHaveLength(1);
    expect(fakeSms.sent[0]!.to).toBe(PHONE);
    expect(fakeSms.sent[0]!.text).toMatch(/PlayerHaat code is \d{6}\. It expires in 5 minutes/);
    const row = await prisma.verificationCode.findFirstOrThrow();
    expect(row).toMatchObject({ type: "PHONE_OTP", target: PHONE });
    expect(row.codeHash).not.toMatch(/^\d{6}$/); // stored hashed
  });

  it("accepts every common way of writing the same number", async () => {
    for (const p of ["01712345678", "+8801712345678", "8801712345678", "+880 1712-345678"]) {
      await backdateCodes();
      expect((await requestCode(p)).status).toBe(200);
    }
    expect(new Set(fakeSms.sent.map((s) => s.to))).toEqual(new Set([PHONE]));
  });

  it.each(["12345", "01212345678", "+447911123456", "abc", ""])("rejects %j", async (phone) => {
    expect((await requestCode(phone)).status).toBe(422);
    expect(fakeSms.sent).toHaveLength(0);
  });

  it("enforces a 60-second cooldown and a cap of 5 texts per number per hour", async () => {
    await requestCode();
    const soon = await requestCode();
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe("AUTH_OTP_COOLDOWN");

    for (let i = 0; i < 4; i++) {
      await backdateCodes();
      expect((await requestCode()).status).toBe(200);
    }
    await backdateCodes();
    const capped = await requestCode();
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("AUTH_OTP_LIMIT");
    expect(fakeSms.sent).toHaveLength(5);
  });

  it("stops everything at the global daily ceiling (SMS-pumping cost cap)", async () => {
    const before = env.SMS_DAILY_LIMIT;
    env.SMS_DAILY_LIMIT = 2;
    try {
      await requestCode("01711111111");
      await requestCode("01722222222");
      const res = await requestCode("01733333333");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("AUTH_SMS_UNAVAILABLE");
      expect(fakeSms.sent).toHaveLength(2);
    } finally {
      env.SMS_DAILY_LIMIT = before;
    }
  });

  it("forgets the code when the gateway fails, so the user can retry immediately", async () => {
    fakeSms.fail = true;
    const res = await requestCode();
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("SMS_SEND_FAILED");
    fakeSms.fail = false;
    expect((await requestCode()).status).toBe(200); // no cooldown penalty
  });

  it("answers 503 when phone sign-in is switched off", async () => {
    fakeSms.enabled = false;
    const res = await requestCode();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUTH_PROVIDER_NOT_CONFIGURED");
  });

  it("looks the same for a number that already has an account", async () => {
    const first = await requestCode();
    await verify(fakeSms.lastCode(PHONE));
    await backdateCodes();
    const again = await requestCode();
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
  });
});

describe("POST /auth/phone/verify", () => {
  it("creates a verified account for a new number, then signs the same user in next time", async () => {
    await requestCode();
    const first = await verify(fakeSms.lastCode(PHONE), { name: "Sohel Rana" });
    expect(first.status).toBe(200);
    expect(first.body.data.isNewUser).toBe(true);
    expect(first.body.data.user).toMatchObject({ name: "Sohel Rana", phone: PHONE, loginMethods: ["PHONE"], hasPassword: false, email: null });
    expect(first.body.data.tokens.accessToken).toBeTruthy();
    expect(await prisma.user.findFirstOrThrow({ where: { phone: PHONE } })).toMatchObject({ phoneVerifiedAt: expect.any(Date) });

    await backdateCodes();
    await requestCode("+8801712345678");
    const second = await verify(fakeSms.lastCode(PHONE), { name: "Ignored" }, "+8801712345678");
    expect(second.body.data.isNewUser).toBe(false);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(second.body.data.user.name).toBe("Sohel Rana");
    expect(await prisma.user.count()).toBe(1);
  });

  it("falls back to a placeholder name when none is sent", async () => {
    await requestCode();
    expect((await verify(fakeSms.lastCode(PHONE))).body.data.user.name).toBe("Player");
  });

  it("is single-use, and rejects wrong, expired and never-requested codes", async () => {
    expect((await verify("123456")).body.error.code).toBe("AUTH_INVALID_OTP"); // nothing requested

    await requestCode();
    const code = fakeSms.lastCode(PHONE);
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await verify(wrong)).body.error.code).toBe("AUTH_INVALID_OTP");
    expect((await verify(code)).status).toBe(200);
    expect((await verify(code)).body.error.code).toBe("AUTH_INVALID_OTP"); // used up

    await backdateCodes();
    await requestCode();
    await prisma.verificationCode.updateMany({ where: { consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(fakeSms.lastCode(PHONE))).body.error.code).toBe("AUTH_OTP_EXPIRED");
  });

  it("locks the code after 5 wrong guesses", async () => {
    await requestCode();
    const code = fakeSms.lastCode(PHONE);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).body.error.code).toBe("AUTH_INVALID_OTP");
    const res = await verify(code);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("AUTH_OTP_TOO_MANY_ATTEMPTS");
  });

  it("a code for one number is useless for another", async () => {
    await requestCode("01711111111");
    const res = await verify(fakeSms.lastCode("+8801711111111"), {}, "01722222222");
    expect(res.status).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it("releases a number someone typed into their profile but never verified, to whoever proves they hold it", async () => {
    const squatter = await signedIn("squatter@example.com");
    await api().patch(`${V1}/users/me`).set(squatter.auth).send({ phone: "01712345678" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: squatter.user.id } })).phone).toBe(PHONE);

    await requestCode();
    const real = await verify(fakeSms.lastCode(PHONE));
    expect(real.status).toBe(200);
    expect(real.body.data.user.id).not.toBe(squatter.user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: squatter.user.id } })).phone).toBeNull();
  });

  it("refuses a suspended account only after the code checks out", async () => {
    await requestCode();
    const made = await verify(fakeSms.lastCode(PHONE));
    await prisma.user.update({ where: { id: made.body.data.user.id }, data: { status: "SUSPENDED" } });
    await backdateCodes();
    await requestCode();
    const res = await verify(fakeSms.lastCode(PHONE));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");
  });

  it("two simultaneous first sign-ins for one number end up as one account", async () => {
    await requestCode();
    const code = fakeSms.lastCode(PHONE);
    const results = await Promise.all([verify(code), verify(code)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1); // the code is single-use
    expect(await prisma.user.count()).toBe(1);
  });

  it("validates the body", async () => {
    expect((await api().post(`${V1}/auth/phone/verify`).send({ phone: "01712345678" })).status).toBe(422);
    expect((await verify("12345")).status).toBe(422);
    expect((await verify("123456", { role: "ADMIN" })).status).toBe(422);
  });
});

describe("phone as a linked login method", () => {
  const link = (auth: Record<string, string>, code: string, phone = "01712345678") => api().post(`${V1}/auth/methods/phone`).set(auth).send({ phone, code });

  it("adds a verified number to an existing account, and the number then signs in to that same account", async () => {
    const u = await registerUser();
    await requestCode();
    const res = await link(bearer(u.accessToken), fakeSms.lastCode(PHONE));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone: PHONE, loginMethods: expect.arrayContaining(["EMAIL", "PHONE"]) });

    await backdateCodes();
    await requestCode();
    const viaPhone = await verify(fakeSms.lastCode(PHONE));
    expect(viaPhone.body.data.user.id).toBe(u.user.id);
    expect(viaPhone.body.data.isNewUser).toBe(false);
  });

  it("refuses a number that belongs to another account, and a second number on the same account", async () => {
    await requestCode("01711111111");
    await verify(fakeSms.lastCode("+8801711111111"), {}, "01711111111"); // someone else owns it
    const u = await registerUser();
    await backdateCodes();
    await requestCode("01711111111");
    const taken = await link(bearer(u.accessToken), fakeSms.lastCode("+8801711111111"), "01711111111");
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("AUTH_PROVIDER_ALREADY_LINKED");

    await requestCode("01722222222");
    expect((await link(bearer(u.accessToken), fakeSms.lastCode("+8801722222222"), "01722222222")).status).toBe(200);
    await requestCode("01733333333");
    expect((await link(bearer(u.accessToken), fakeSms.lastCode("+8801733333333"), "01733333333")).status).toBe(409);
  });

  it("needs a valid code and authentication", async () => {
    const u = await registerUser();
    await requestCode();
    expect((await link(bearer(u.accessToken), "000000")).status).toBe(400);
    expect((await api().post(`${V1}/auth/methods/phone`).send({ phone: "01712345678", code: "123456" })).status).toBe(401);
  });

  it("a verified login number can't be silently swapped through PATCH /users/me", async () => {
    await requestCode();
    const made = await verify(fakeSms.lastCode(PHONE));
    const auth = bearer(made.body.data.tokens.accessToken);
    const res = await api().patch(`${V1}/users/me`).set(auth).send({ phone: "01799999999" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USER_PHONE_LOCKED");
  });

  it("can be removed when another login method remains — and never when it's the last", async () => {
    await requestCode();
    const made = await verify(fakeSms.lastCode(PHONE));
    const auth = bearer(made.body.data.tokens.accessToken);
    const last = await api().delete(`${V1}/auth/methods/PHONE`).set(auth);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("AUTH_LAST_LOGIN_METHOD");

    const u = await registerUser();
    await backdateCodes();
    await requestCode("01744444444");
    await link(bearer(u.accessToken), fakeSms.lastCode("+8801744444444"), "01744444444");
    const removed = await api().delete(`${V1}/auth/methods/PHONE`).set(bearer(u.accessToken));
    expect(removed.status).toBe(200);
    expect(removed.body.data.loginMethods).toEqual(["EMAIL"]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.user.id } })).phoneVerifiedAt).toBeNull();
    expect((await login(DEFAULT_USER.email)).status).toBe(200);
  });
});
