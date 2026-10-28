import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { codeAt, currentStep, decryptSecret } from "../src/lib/totp.js";
import { rateLimitControl } from "../src/middlewares/rate-limit.js";
import { V1, api, bearer, playerUser, prisma, recruiterUser, registerUser, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
const PASSWORD = "Passw0rd1";
beforeAll(() => {
  env.ADMIN_REQUIRE_2FA = true; // production behaviour for this file; everything else runs with it off
});
afterAll(() => {
  env.ADMIN_REQUIRE_2FA = false;
});
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

async function makeAdmin(email = "admin@example.com") {
  const u = await registerUser({ email, name: "Super Admin" });
  await prisma.user.update({ where: { id: u.user.id }, data: { role: "ADMIN" } });
  return u;
}
const login = (email = "admin@example.com", password = PASSWORD) => api().post(`${V1}/admin/auth/login`).send({ email, password });
const post = (path: string, body: object) => api().post(`${V1}/admin/auth${path}`).send(body);
const cookieOf = (res: { headers: Record<string, unknown> }) => ((res.headers["set-cookie"] as string[] | undefined) ?? []).find((c) => c.startsWith("ph_admin_refresh="));

/** Signs a brand-new admin all the way through setup, returning what a real client would hold. */
async function enroll(email = "admin@example.com") {
  await makeAdmin(email);
  const { challengeToken } = (await login(email)).body.data;
  const setup = (await post("/2fa/setup", { challengeToken })).body.data as { secret: string; otpauthUrl: string };
  const enable = await post("/2fa/enable", { challengeToken, code: codeAt(setup.secret, currentStep()) });
  return { secret: setup.secret, enable, usedStep: currentStep() };
}

describe("the password step", () => {
  it("opens no session: it hands back a challenge, and says whether this is first-time setup", async () => {
    await makeAdmin();
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: "TOTP_SETUP_REQUIRED", challengeToken: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
    expect(cookieOf(res)).toBeUndefined();
  });

  it("still gives players, recruiters and strangers the same 401 as a wrong password", async () => {
    await makeAdmin();
    await playerUser(w, "p@example.com");
    await recruiterUser(w, "r@example.com");
    for (const [email, pw] of [["admin@example.com", "Wr0ngPassword"], ["p@example.com", PASSWORD], ["r@example.com", PASSWORD], ["nobody@example.com", PASSWORD]]) {
      const res = await login(email, pw);
      expect(res.status, email).toBe(401);
      expect(res.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    }
  });
});

describe("first-time setup", () => {
  it("a valid first code turns two-factor on, shows backup codes once, and signs in with an httpOnly cookie", async () => {
    const { enable, secret } = await enroll();
    expect(enable.status).toBe(200);
    expect(enable.body.data.backupCodes).toHaveLength(8);
    expect(enable.body.data.refreshToken).toBeUndefined(); // the refresh token never appears in the body
    const cookie = cookieOf(enable)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/admin\/auth/);

    const me = await api().get(`${V1}/admin/me`).set(bearer(enable.body.data.accessToken));
    expect(me.body.data).toMatchObject({ email: "admin@example.com", role: "ADMIN" });
    // The dashboard sends NO body — the cookie is the credential — so a missing body must be accepted.
    const refreshed = await api().post(`${V1}/admin/auth/refresh`).set("Cookie", cookie.split(";")[0]!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(cookieOf(refreshed)).toMatch(/HttpOnly/i); // and the cookie is rotated
    expect((await api().post(`${V1}/admin/auth/refresh`)).status).toBe(401); // no cookie, no body: unauthenticated, not a validation error
    const out = await api().post(`${V1}/admin/auth/logout`).set("Cookie", cookieOf(refreshed)!.split(";")[0]!);
    expect(out.status).toBe(200);
    expect((await api().post(`${V1}/admin/auth/refresh`).set("Cookie", cookieOf(refreshed)!.split(";")[0]!)).status).toBe(401); // signed out for real

    const row = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.totpSecret).not.toContain(secret); // encrypted at rest…
    expect(decryptSecret(row.totpSecret!)).toBe(secret); // …and recoverable by the server
    expect(row.totpBackupHashes).toHaveLength(8);
    expect(JSON.stringify(row.totpBackupHashes)).not.toContain(enable.body.data.backupCodes[0]); // only hashes are kept
  });

  it("a wrong first code leaves two-factor off and signs nobody in", async () => {
    await makeAdmin();
    const { challengeToken } = (await login()).body.data;
    const { secret } = (await post("/2fa/setup", { challengeToken })).body.data;
    const bad = await post("/2fa/enable", { challengeToken, code: codeAt(secret, currentStep() + 5) });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("AUTH_INVALID_TOTP");
    expect((await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } })).totpEnabledAt).toBeNull();
    expect((await post("/2fa/enable", { challengeToken, code: "12" })).status).toBe(422);
  });

  it("can't be run again once it's on (nobody can swap the secret from a stolen password)", async () => {
    await enroll();
    const { challengeToken, status } = (await login()).body.data;
    expect(status).toBe("TOTP_REQUIRED");
    const again = await post("/2fa/setup", { challengeToken });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("AUTH_TOTP_ALREADY_ENABLED");
  });

  it("enable needs setup first", async () => {
    await makeAdmin();
    const { challengeToken } = (await login()).body.data;
    expect((await post("/2fa/enable", { challengeToken, code: "123456" })).body.error.code).toBe("AUTH_TOTP_NOT_STARTED");
  });
});

describe("every later sign-in", () => {
  it("password, then a current code → a session; the same code can't be used twice", async () => {
    const { secret, usedStep } = await enroll();
    const { challengeToken, status } = (await login()).body.data;
    expect(status).toBe("TOTP_REQUIRED");

    const code = codeAt(secret, usedStep + 1); // the next step: valid, and newer than the one that enabled it
    const ok = await post("/2fa/verify", { challengeToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
    expect(cookieOf(ok)).toMatch(/HttpOnly/i);

    const replay = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("AUTH_INVALID_TOTP");
  });

  it("the code that enabled two-factor can't be replayed to sign in", async () => {
    const { secret, usedStep } = await enroll();
    const res = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, code: codeAt(secret, usedStep) });
    expect(res.status).toBe(401);
  });

  it("two simultaneous submissions of one code let exactly one in", async () => {
    const { secret, usedStep } = await enroll();
    const code = codeAt(secret, usedStep + 1);
    const tokens = [(await login()).body.data.challengeToken, (await login()).body.data.challengeToken];
    const results = await Promise.all(tokens.map((challengeToken) => post("/2fa/verify", { challengeToken, code })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("a backup code works once", async () => {
    const { enable } = await enroll();
    const [first, second] = enable.body.data.backupCodes as string[];
    const a = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, backupCode: first!.toUpperCase() }); // case doesn't matter
    expect(a.status).toBe(200);
    const again = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, backupCode: first });
    expect(again.status).toBe(401);
    expect((await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, backupCode: second })).status).toBe(200);
    expect((await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } })).totpBackupHashes).toHaveLength(6);
  });

  it("needs a code or a backup code, not both, not neither", async () => {
    const { secret } = await enroll();
    const challengeToken = (await login()).body.data.challengeToken;
    expect((await post("/2fa/verify", { challengeToken })).status).toBe(422);
    expect((await post("/2fa/verify", { challengeToken, code: codeAt(secret, currentStep()), backupCode: "abc-def-ghi" })).status).toBe(422);
    expect((await post("/2fa/verify", { challengeToken, code: "abcdef" })).status).toBe(422);
  });
});

describe("the challenge token", () => {
  it("is not an access token", async () => {
    await makeAdmin();
    const { challengeToken } = (await login()).body.data;
    for (const path of ["/admin/me", "/admin/users", "/users/me"]) {
      expect((await api().get(`${V1}${path}`).set(bearer(challengeToken))).status, path).toBe(401);
    }
  });

  it("is refused when forged, expired, empty or about someone who isn't an admin", async () => {
    const admin = await makeAdmin();
    const player = await playerUser(w, "p@example.com");
    const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!);
    const mint = (sub: string, over: { iss?: string; exp?: string } = {}) =>
      new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuer(over.iss ?? "playerhaat-admin-2fa").setIssuedAt().setExpirationTime(over.exp ?? "5m").sign(key);
    const cases = [
      await mint(admin.user.id, { iss: "playerhaat-api" }), // the access-token issuer: wrong purpose
      await mint(admin.user.id, { exp: "-1m" }), // expired
      await mint(player.user.id), // valid signature, but not an admin
      "x".repeat(30),
    ];
    for (const challengeToken of cases) {
      const res = await post("/2fa/setup", { challengeToken });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_CHALLENGE_INVALID");
    }
  });
});

describe("guessing codes", () => {
  it("is capped per admin account: 8 tries, then 429 — even with the right code afterwards", async () => {
    const { secret, usedStep } = await enroll();
    rateLimitControl.forceEnabled = true;
    try {
      const challengeToken = (await login()).body.data.challengeToken;
      for (let i = 0; i < 8; i++) expect((await post("/2fa/verify", { challengeToken, code: "000000" })).status).toBe(401);
      const blocked = await post("/2fa/verify", { challengeToken, code: codeAt(secret, usedStep + 1) });
      expect(blocked.status).toBe(429);
      // a fresh challenge doesn't reset the count: it's counted against the admin, not the token
      expect((await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, code: codeAt(secret, usedStep + 1) })).status).toBe(429);
    } finally {
      rateLimitControl.forceEnabled = false;
    }
  });
});

describe("account: sessions and backup codes", () => {
  it("lists my sessions and signs one out remotely", async () => {
    const { enable, secret, usedStep } = await enroll();
    const second = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, code: codeAt(secret, usedStep + 1) });
    const auth = bearer(enable.body.data.accessToken);
    const list = (await api().get(`${V1}/admin/me/sessions`).set(auth)).body.data as Array<{ id: string }>;
    expect(list).toHaveLength(3); // the sign-up of the test account, enrolment, and the second sign-in
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|refreshToken/);
    expect((await api().delete(`${V1}/admin/me/sessions/${list[0]!.id}`).set(auth)).body.data.revoked).toBe(true);
    expect((await api().get(`${V1}/admin/me/sessions`).set(auth)).body.data).toHaveLength(2);
    expect((await api().delete(`${V1}/admin/me/sessions/nope`).set(auth)).status).toBe(404);
    void second;
  });

  it("replacing backup codes needs a current code and retires the old set", async () => {
    const { enable, secret, usedStep } = await enroll();
    const auth = bearer(enable.body.data.accessToken);
    const old = enable.body.data.backupCodes as string[];
    expect((await api().post(`${V1}/admin/me/2fa/backup-codes`).set(auth).send({ code: "000000" })).status).toBe(401);
    const fresh = await api().post(`${V1}/admin/me/2fa/backup-codes`).set(auth).send({ code: codeAt(secret, usedStep + 1) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.backupCodes).toHaveLength(8);
    const oldTry = await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, backupCode: old[0] });
    expect(oldTry.status).toBe(401);
    expect((await post("/2fa/verify", { challengeToken: (await login()).body.data.challengeToken, backupCode: fresh.body.data.backupCodes[0] })).status).toBe(200);
  });

  it("is for admins only", async () => {
    const player = await playerUser(w, "p@example.com");
    for (const path of ["/admin/me/sessions"]) expect((await api().get(`${V1}${path}`).set(player.auth)).status).toBe(403);
    expect((await api().get(`${V1}/admin/me/sessions`)).status).toBe(401);
  });
});

describe("with two-factor off (development and the rest of the tests)", () => {
  it("password alone still signs in", async () => {
    env.ADMIN_REQUIRE_2FA = false;
    try {
      await makeAdmin();
      const res = await login();
      expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
      expect(cookieOf(res)).toMatch(/HttpOnly/i);
    } finally {
      env.ADMIN_REQUIRE_2FA = true;
    }
  });
});
