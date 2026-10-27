import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeToken } from "./fake-social.js";
import { fakeSms } from "./fake-sms.js";
import { V1, adminLogin, adminUser, api, bearer, login, playerUser, prisma, recruiterUser, registerAs, registerUser, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const call = (method: "get" | "post" | "patch" | "put" | "delete", path: string, auth?: Record<string, string>, body: object = {}) => {
  const t = api()[method](`${V1}${path}`);
  return (auth ? t.set(auth) : t).send(body);
};

describe("sign-up account type", () => {
  it("defaults to PLAYER, so existing app builds keep working", async () => {
    const { user } = await registerUser({ email: "old@example.com" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("PLAYER");
  });

  it.each(["PLAYER", "RECRUITER"] as const)("registers a %s and says so in the session", async (role) => {
    const res = await api().post(`${V1}/auth/register`).send({ name: "Sara", email: `${role}@example.com`, password: "Passw0rd1", role });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe(role);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: `${role}@example.com`.toLowerCase() } })).role).toBe(role);
  });

  it.each(["ADMIN", "SUPERADMIN", "admin", "USER", "", 1, null])("refuses %j — admins can't be created through sign-up", async (role) => {
    const res = await api().post(`${V1}/auth/register`).send({ name: "Eve", email: "eve@example.com", password: "Passw0rd1", role });
    expect(res.status).toBe(422);
    expect(await prisma.user.count()).toBe(0);
  });

  it("applies to Google sign-up, and never changes an existing account's role", async () => {
    const first = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-r", email: "scout@example.com" }), role: "RECRUITER" });
    expect(first.body.data.user.role).toBe("RECRUITER");

    const again = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-r", email: "scout@example.com" }), role: "PLAYER" });
    expect(again.body.data.user.role).toBe("RECRUITER");

    // Linking Google to an existing PLAYER by email must not let the request pick a new role either.
    const p = await registerAs("PLAYER", "plain@example.com");
    await prisma.user.update({ where: { id: p.user.id }, data: { emailVerifiedAt: new Date() } });
    const linked = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-p", email: "plain@example.com" }), role: "RECRUITER" });
    expect(linked.body.data.user.id).toBe(p.user.id);
    expect(linked.body.data.user.role).toBe("PLAYER");
  });

  it("applies to phone sign-up for brand-new numbers only", async () => {
    await api().post(`${V1}/auth/phone/request`).send({ phone: "01712345678" });
    const res = await api().post(`${V1}/auth/phone/verify`).send({ phone: "01712345678", code: fakeSms.lastCode("+8801712345678"), role: "RECRUITER" });
    expect(res.body.data).toMatchObject({ isNewUser: true, user: { role: "RECRUITER" } });
  });

  it("cannot be used to change role later (no mass assignment on /users/me)", async () => {
    const p = await registerAs("PLAYER", "p@example.com");
    await call("patch", "/users/me", p.auth, { role: "ADMIN" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: p.user.id } })).role).toBe("PLAYER");
  });
});

describe("admin accounts", () => {
  it("can't sign in through the public paths, only through the dashboard", async () => {
    const admin = await adminUser("admin@example.com");

    const viaPassword = await login("admin@example.com");
    expect(viaPassword.status).toBe(403);
    expect(viaPassword.body.error.code).toBe("AUTH_ADMIN_DASHBOARD_ONLY");

    await prisma.user.update({ where: { id: admin.user.id }, data: { emailVerifiedAt: new Date() } });
    const viaGoogle = await api().post(`${V1}/auth/google`).send({ idToken: fakeToken({ providerUserId: "g-a", email: "admin@example.com" }) });
    expect(viaGoogle.status).toBe(403);
    expect(viaGoogle.body.error.code).toBe("AUTH_ADMIN_DASHBOARD_ONLY");

    const viaDashboard = await adminLogin("admin@example.com");
    expect(viaDashboard.status).toBe(200);
    expect(viaDashboard.body.data.user.role).toBe("ADMIN");
  });

  it("gets the same 401 as a wrong password when a non-admin (or nobody) tries the dashboard login", async () => {
    await registerAs("PLAYER", "p@example.com");
    await adminUser("admin@example.com");
    const wrongPassword = await adminLogin("admin@example.com", "Wr0ngPassword");
    const player = await adminLogin("p@example.com");
    const nobody = await adminLogin("nobody@example.com");
    for (const r of [wrongPassword, player, nobody]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    }
  });

  it("keeps its dashboard session alive through the normal refresh endpoint", async () => {
    await adminUser("admin@example.com");
    const { tokens } = (await adminLogin("admin@example.com")).body.data;
    const refreshed = await api().post(`${V1}/auth/refresh`).send({ refreshToken: tokens.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await call("get", "/admin/me", bearer(refreshed.body.data.accessToken))).body.data).toMatchObject({ email: "admin@example.com", role: "ADMIN" });
  });

  it("is turned away from every mobile endpoint, even with a perfectly valid token", async () => {
    await adminUser("admin@example.com");
    const auth = bearer((await adminLogin("admin@example.com")).body.data.tokens.accessToken);
    const endpoints: Array<["get" | "post" | "patch" | "delete", string]> = [
      ["get", "/users/me"],
      ["patch", "/users/me"],
      ["get", "/players"],
      ["get", "/players/me"],
      ["post", "/players/me"],
      ["get", "/players/someone"],
      ["get", "/recruiters/me"],
      ["get", "/requests"],
      ["post", "/requests"],
      ["get", "/applications/mine"],
      ["get", "/notifications"],
      ["get", "/ratings/pending"],
      ["post", "/reports"],
      ["post", "/media/images"],
      ["delete", "/users/me"],
    ];
    for (const [method, path] of endpoints) {
      const res = await call(method, path, auth);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe("AUTH_FORBIDDEN");
    }
  });
});

describe("admin endpoints", () => {
  it("are closed to players and recruiters, and a role change takes effect on the very next request", async () => {
    const rec = await recruiterUser(w);
    const player = await registerAs("PLAYER", "p@example.com");
    for (const who of [rec, player]) expect((await call("get", "/admin/users", who.auth)).status).toBe(403);

    // Promoted in the DB → the same old token now works, because the role is read per request.
    await prisma.user.update({ where: { id: player.user.id }, data: { role: "ADMIN" } });
    expect((await call("get", "/admin/users", player.auth)).status).toBe(200);
    // …and it then stops working on the mobile side.
    expect((await call("get", "/users/me", player.auth)).status).toBe(403);
  });

  it("ignore a role claim inside the token (the database decides)", async () => {
    const p = await registerAs("PLAYER", "p@example.com");
    const forged = await new SignJWT({ role: "ADMIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(p.user.id)
      .setIssuer("playerhaat-api")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));
    expect((await call("get", "/admin/users", bearer(forged))).status).toBe(403);
  });
});

describe("player-only and recruiter-only features", () => {
  it("keeps recruiters out of player-profile management and applying", async () => {
    const rec = await recruiterUser(w);
    expect((await call("get", "/players/me", rec.auth)).status).toBe(403);
    expect((await call("post", "/players/me", rec.auth, { districtId: w.patuakhali.id, upazilaId: w.kalapara.id })).status).toBe(403);
    expect((await call("post", "/players/me/sports", rec.auth, {})).status).toBe(403);

    const poster = await signedIn("poster@example.com");
    const reqRes = await call("post", "/requests", poster.auth, {
      sportId: w.football.id, matchAt: new Date(Date.now() + 48 * 3_600_000).toISOString(), venueText: "Ground",
      districtId: w.patuakhali.id, upazilaId: w.kalapara.id, positionsNeeded: ["GK"], playersNeeded: 1,
    });
    expect(reqRes.status).toBe(201);
    expect((await call("post", `/requests/${reqRes.body.data.id}/applications`, rec.auth, {})).status).toBe(403);
  });

  it("keeps players out of recruiter-profile management, but lets them read a recruiter's public card", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com");
    expect((await call("get", "/recruiters/me", p.auth)).status).toBe(403);
    expect((await call("post", "/recruiters/me", p.auth, {})).status).toBe(403);
    expect((await call("get", `/recruiters/${rec.recruiterId}`, p.auth)).status).toBe(200);
  });

  it("lets recruiters still post requests and rate the players they used", async () => {
    const rec = await recruiterUser(w);
    const res = await call("post", "/requests", rec.auth, {
      sportId: w.football.id, matchAt: new Date(Date.now() + 48 * 3_600_000).toISOString(), venueText: "Trial ground",
      districtId: w.patuakhali.id, upazilaId: w.kalapara.id, positionsNeeded: ["ST"], playersNeeded: 1,
    });
    expect(res.status).toBe(201);
  });
});

describe("onboarding state on /users/me", () => {
  it("tells each role which setup step is next", async () => {
    const player = await registerAs("PLAYER", "p@example.com");
    const rec = await registerAs("RECRUITER", "r@example.com");
    expect((await call("get", "/users/me", player.auth)).body.data).toMatchObject({ role: "PLAYER", onboardingStep: "PLAYER_PROFILE", hasPlayerProfile: false });
    expect((await call("get", "/users/me", rec.auth)).body.data).toMatchObject({ role: "RECRUITER", onboardingStep: "RECRUITER_PROFILE", hasRecruiterProfile: false });

    await playerUser(w, "done@example.com");
    const done = await recruiterUser(w, "rdone@example.com");
    expect((await call("get", "/users/me", done.auth)).body.data).toMatchObject({ onboardingStep: null, hasRecruiterProfile: true });
  });
});

describe("request poster", () => {
  it("links a recruiter's request to their public card, and leaves players' as null", async () => {
    const rec = await recruiterUser(w);
    const player = await playerUser(w, "p@example.com");
    const body = { sportId: w.football.id, matchAt: new Date(Date.now() + 48 * 3_600_000).toISOString(), venueText: "Ground", districtId: w.patuakhali.id, upazilaId: w.kalapara.id, positionsNeeded: ["ST"], playersNeeded: 1 };
    const fromRec = await call("post", "/requests", rec.auth, body);
    const fromPlayer = await call("post", "/requests", player.auth, body);
    const viewer = await playerUser(w, "viewer2@example.com");
    expect((await call("get", `/requests/${fromRec.body.data.id}`, viewer.auth)).body.data.captain).toMatchObject({ recruiterId: rec.recruiterId, recruiterVerified: false });
    expect((await call("get", `/requests/${fromPlayer.body.data.id}`, viewer.auth)).body.data.captain.recruiterId).toBeNull();
  });
});
