import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, completedMatch, hoursFromNow, login, makeApplication, makeRequest, playerUser, prisma, requestBody, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});

const get = (a: Auth, path: string, query: Record<string, string | number | boolean> = {}) => api().get(`${V1}${path}`).set(a).query(query);
const post = (a: Auth, path: string, body: object = {}) => api().post(`${V1}${path}`).set(a).send(body);
const put = (a: Auth, path: string, body: object) => api().put(`${V1}${path}`).set(a).send(body);
const actions = (targetId?: string) => prisma.adminAction.findMany({ where: targetId ? { targetId } : {}, orderBy: { createdAt: "asc" } });

describe("access control", () => {
  const endpoints: Array<[string, string]> = [
    ["get", "/admin/users"],
    ["get", "/admin/reports"],
    ["get", "/admin/actions"],
    ["get", "/admin/app-config"],
    ["post", "/admin/users/x/suspend"],
    ["post", "/admin/players/x/hide"],
    ["post", "/admin/requests/x/hide"],
    ["post", "/admin/reports/x/resolve"],
    ["put", "/admin/app-config/ads_enabled"],
  ];

  it("blocks ordinary users with 403 and anonymous callers with 401 on every admin route", async () => {
    const user = await signedIn("user@example.com");
    for (const [method, path] of endpoints) {
      const asUser = await (api() as unknown as Record<string, (p: string) => import("supertest").Test>)[method]!(`${V1}${path}`).set(user.auth).send({});
      expect(asUser.status, `${method} ${path}`).toBe(403);
      expect(asUser.body.error.code).toBe("AUTH_FORBIDDEN");
      const anon = await (api() as unknown as Record<string, (p: string) => import("supertest").Test>)[method]!(`${V1}${path}`).send({});
      expect(anon.status, `${method} ${path}`).toBe(401);
    }
  });

  it("reads the role from the database, so revoking admin takes effect immediately", async () => {
    expect((await get(admin.auth, "/admin/users")).status).toBe(200);
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: "PLAYER" } });
    expect((await get(admin.auth, "/admin/users")).status).toBe(403);
  });
});

describe("users", () => {
  it("lists and searches by name, email or phone, with status/role filters and pagination", async () => {
    const a = await signedIn("alpha@example.com");
    await prisma.user.update({ where: { id: a.user.id }, data: { name: "Alpha Rahman", phone: "+8801711111111" } });
    const b = await signedIn("beta@example.com");
    await prisma.user.update({ where: { id: b.user.id }, data: { name: "Beta Khan", status: "SUSPENDED" } });

    const names = (res: { body: { data: Array<{ name: string }> } }) => res.body.data.map((u) => u.name).sort();
    expect(names(await get(admin.auth, "/admin/users", { q: "alpha" }))).toEqual(["Alpha Rahman"]);
    expect(names(await get(admin.auth, "/admin/users", { q: "BETA@EXAMPLE" }))).toEqual(["Beta Khan"]);
    expect(names(await get(admin.auth, "/admin/users", { q: "01711111" }))).toEqual(["Alpha Rahman"]);
    expect(names(await get(admin.auth, "/admin/users", { status: "SUSPENDED" }))).toEqual(["Beta Khan"]);
    expect((await get(admin.auth, "/admin/users", { role: "ADMIN" })).body.data).toHaveLength(1);

    const first = await get(admin.auth, "/admin/users", { limit: 2 });
    const second = await get(admin.auth, "/admin/users", { limit: 2, cursor: first.body.meta.nextCursor });
    expect(first.body.data).toHaveLength(2);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeNull();
    expect(JSON.stringify(first.body)).not.toMatch(/passwordHash/);
  });

  it("shows a user's detail: profile moderation state and activity counts", async () => {
    const p = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
    await makeRequest(w, p.user.id);
    const res = await get(admin.auth, `/admin/users/${p.user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: p.user.id,
      email: "player@example.com",
      profileId: p.profileId,
      playerProfile: { id: p.profileId, isVisible: true, hiddenByAdmin: false, verifiedBadge: false, sports: [expect.objectContaining({ sportCode: "FOOTBALL" })] },
      counts: { requestsPosted: 1, applications: 0, reportsAgainst: 0 },
    });
    expect((await get(admin.auth, "/admin/users/nope")).body.error.code).toBe("USER_NOT_FOUND");
  });
});

describe("suspend / unsuspend", () => {
  it("blocks sign-in at once, revokes every session, and writes an audit entry", async () => {
    const u = await signedIn("target@example.com");
    const res = await post(admin.auth, `/admin/users/${u.user.id}/suspend`, { reason: "Repeated no-shows and abuse" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SUSPENDED");

    expect((await api().get(`${V1}/users/me`).set(u.auth)).body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED"); // live access token
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken: u.refreshToken })).status).toBe(401);
    expect((await login("target@example.com")).body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");

    const log = await actions(u.user.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ adminId: admin.user.id, action: "USER_SUSPEND", targetType: "USER", reason: "Repeated no-shows and abuse" });
  });

  it("takes them out of play: cancels their upcoming requests and withdraws their applications, telling the other side", async () => {
    const target = await playerUser(w, "target@example.com", [{ sportId: w.football.id }]);
    const other = await playerUser(w, "other@example.com", [{ sportId: w.football.id }]);
    const waiting = await playerUser(w, "waiting@example.com", [{ sportId: w.football.id }]);

    // as a captain
    const mine = await makeRequest(w, target.user.id, { playersNeeded: 2, playersAccepted: 1, venueText: "Mine" });
    await makeApplication(mine.id, other.user.id, "ACCEPTED");
    await makeApplication(mine.id, waiting.user.id, "PENDING");
    const finished = await makeRequest(w, target.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-30) });

    // as a player: one accepted (FILLED match), one pending
    const captain = await signedIn("captain@example.com");
    const filled = await makeRequest(w, captain.user.id, { status: "FILLED", playersNeeded: 1, playersAccepted: 1 });
    const acceptedApp = await makeApplication(filled.id, target.user.id, "ACCEPTED");
    const open = await makeRequest(w, captain.user.id);
    const pendingApp = await makeApplication(open.id, target.user.id, "PENDING");

    await post(admin.auth, `/admin/users/${target.user.id}/suspend`, { reason: "fraud suspected" });
    await settle();

    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("CANCELLED");
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: finished.id } })).status).toBe("COMPLETED"); // history untouched
    expect((await prisma.application.findUniqueOrThrow({ where: { id: acceptedApp.id } })).status).toBe("WITHDRAWN");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: pendingApp.id } })).status).toBe("WITHDRAWN");
    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: filled.id } })).toMatchObject({ status: "OPEN", playersAccepted: 0 }); // spot freed
    expect((await prisma.application.findFirstOrThrow({ where: { requestId: mine.id, playerId: waiting.user.id } })).status).toBe("REJECTED");

    const told = (type: string) => prisma.notification.findMany({ where: { type: type as "REQUEST_CANCELLED" } }).then((r) => r.map((n) => n.userId).sort());
    expect(await told("REQUEST_CANCELLED")).toEqual([other.user.id, waiting.user.id].sort());
    expect(await told("APPLICATION_WITHDRAWN")).toEqual([captain.user.id]);
  });

  it("is refused for admins, for yourself, for deleted and already-suspended accounts, and needs a reason", async () => {
    const other = await adminUser("admin2@example.com");
    const gone = await signedIn("gone@example.com");
    await prisma.user.update({ where: { id: gone.user.id }, data: { status: "DELETED" } });
    const sus = await signedIn("sus@example.com");
    await post(admin.auth, `/admin/users/${sus.user.id}/suspend`, { reason: "first time" });

    expect((await post(admin.auth, `/admin/users/${other.user.id}/suspend`, { reason: "nope" })).body.error.code).toBe("ADMIN_CANNOT_TARGET_ADMIN");
    expect((await post(admin.auth, `/admin/users/${admin.user.id}/suspend`, { reason: "nope" })).body.error.code).toBe("ADMIN_CANNOT_TARGET_SELF");
    expect((await post(admin.auth, `/admin/users/${gone.user.id}/suspend`, { reason: "nope" })).body.error.code).toBe("USER_DELETED");
    expect((await post(admin.auth, `/admin/users/${sus.user.id}/suspend`, { reason: "again" })).body.error.code).toBe("USER_ALREADY_SUSPENDED");
    expect((await post(admin.auth, `/admin/users/nope/suspend`, { reason: "nope" })).body.error.code).toBe("USER_NOT_FOUND");
    const ok = await signedIn("ok@example.com");
    expect((await post(admin.auth, `/admin/users/${ok.user.id}/suspend`, {})).status).toBe(422);
    expect((await post(admin.auth, `/admin/users/${ok.user.id}/suspend`, { reason: "ab" })).status).toBe(422);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ok.user.id } })).status).toBe("ACTIVE");
  });

  it("unsuspend restores sign-in but not what was cancelled, and only applies to suspended users", async () => {
    const u = await playerUser(w, "target@example.com", [{ sportId: w.football.id }]);
    const r = await makeRequest(w, u.user.id);
    await post(admin.auth, `/admin/users/${u.user.id}/suspend`, { reason: "cooling off" });
    expect((await post(admin.auth, `/admin/users/${u.user.id}/unsuspend`, { reason: "appealed" })).body.data.status).toBe("ACTIVE");
    expect((await login("target@example.com")).status).toBe(200);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("CANCELLED");
    expect((await post(admin.auth, `/admin/users/${u.user.id}/unsuspend`)).body.error.code).toBe("USER_NOT_SUSPENDED");
    expect((await actions(u.user.id)).map((a) => a.action)).toEqual(["USER_SUSPEND", "USER_UNSUSPEND"]);
  });
});

describe("profiles", () => {
  it("hide removes a profile from search and public view; the player can't undo it; unhide restores", async () => {
    const p = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
    const viewer = await signedIn("viewer@example.com");
    expect((await get(viewer.auth, "/players")).body.data).toHaveLength(1);

    const res = await post(admin.auth, `/admin/players/${p.profileId}/hide`, { reason: "fake photos" });
    expect(res.body.data).toMatchObject({ id: p.profileId, hiddenByAdmin: true });
    expect((await get(viewer.auth, "/players")).body.data).toEqual([]);
    expect((await get(viewer.auth, `/players/${p.profileId}`)).status).toBe(404);

    await api().patch(`${V1}/players/me`).set(p.auth).send({ isVisible: true }); // the player tries to undo it
    expect((await get(viewer.auth, `/players/${p.profileId}`)).status).toBe(404);

    expect((await post(admin.auth, `/admin/players/${p.profileId}/hide`, { reason: "again" })).body.error.code).toBe("PROFILE_ALREADY_HIDDEN");
    await post(admin.auth, `/admin/players/${p.profileId}/unhide`, { reason: "photos replaced" });
    expect((await get(viewer.auth, `/players/${p.profileId}`)).status).toBe(200);
    expect((await post(admin.auth, `/admin/players/${p.profileId}/unhide`)).body.error.code).toBe("PROFILE_NOT_HIDDEN");
    expect((await actions(p.profileId)).map((a) => a.action)).toEqual(["PROFILE_HIDE", "PROFILE_UNHIDE"]);
  });

  it("hidden players stop receiving new-request pushes", async () => {
    const poster = await signedIn("poster@example.com");
    const p = await playerUser(w, "player@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    await post(admin.auth, `/admin/players/${p.profileId}/hide`, { reason: "review pending" });
    await api().post(`${V1}/requests`).set(poster.auth).send(requestBody(w));
    await settle();
    expect(await prisma.notification.count({ where: { userId: p.user.id } })).toBe(0);
  });

  it("grants and removes the verified badge, shows it in search, and doesn't log no-ops", async () => {
    const p = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
    const viewer = await signedIn("viewer@example.com");
    expect((await post(admin.auth, `/admin/players/${p.profileId}/verify`, { verified: true })).body.data.verifiedBadge).toBe(true);
    expect((await get(viewer.auth, "/players")).body.data[0].verifiedBadge).toBe(true);
    await post(admin.auth, `/admin/players/${p.profileId}/verify`, { verified: true }); // already true
    await post(admin.auth, `/admin/players/${p.profileId}/verify`, { verified: false });
    expect((await actions(p.profileId)).map((a) => a.action)).toEqual(["PROFILE_VERIFY", "PROFILE_UNVERIFY"]);
    expect((await post(admin.auth, `/admin/players/${p.profileId}/verify`, {})).status).toBe(422);
    expect((await post(admin.auth, `/admin/players/nope/verify`, { verified: true })).status).toBe(404);
  });

  it("players can't grant themselves the badge through their own endpoints", async () => {
    const p = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
    expect((await api().patch(`${V1}/players/me`).set(p.auth).send({ verifiedBadge: true })).status).toBe(422);
    expect((await prisma.playerProfile.findUniqueOrThrow({ where: { id: p.profileId } })).verifiedBadge).toBe(false);
  });
});

describe("requests", () => {
  it("hide pulls a request from the feed, direct view and applications — but the poster still sees it", async () => {
    const poster = await signedIn("poster@example.com");
    const player = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
    const r = await makeRequest(w, poster.user.id);
    expect((await get(player.auth, "/requests")).body.data).toHaveLength(1);

    await post(admin.auth, `/admin/requests/${r.id}/hide`, { reason: "scam" });
    expect((await get(player.auth, "/requests")).body.data).toEqual([]);
    expect((await get(player.auth, `/requests/${r.id}`)).status).toBe(404);
    expect((await post(player.auth, `/requests/${r.id}/applications`)).status).toBe(404);
    expect((await get(poster.auth, `/requests/${r.id}`)).status).toBe(200);

    expect((await post(admin.auth, `/admin/requests/${r.id}/hide`, { reason: "again" })).body.error.code).toBe("REQUEST_ALREADY_HIDDEN");
    await post(admin.auth, `/admin/requests/${r.id}/unhide`);
    expect((await get(player.auth, `/requests/${r.id}`)).status).toBe(200);
    expect((await post(admin.auth, `/admin/requests/${r.id}/unhide`)).body.error.code).toBe("REQUEST_NOT_HIDDEN");
    expect((await post(admin.auth, `/admin/requests/nope/hide`, { reason: "x y z" })).status).toBe(404);
  });
});

describe("report queue", () => {
  const file = async (reporterEmail: string, targetType: string, targetId: string, reason = "SPAM") => {
    const r = await signedIn(reporterEmail);
    const res = await post(r.auth, "/reports", { targetType, targetId, reason });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  it("lists OPEN reports oldest first by default, other statuses newest first, and counts open reports per target", async () => {
    const offender = await playerUser(w, "offender@example.com", [{ sportId: w.football.id }]);
    const poster = await signedIn("poster@example.com");
    const req = await makeRequest(w, poster.user.id);
    const r1 = await file("a@example.com", "PLAYER_PROFILE", offender.profileId);
    await new Promise((x) => setTimeout(x, 5));
    const r2 = await file("b@example.com", "PLAYER_PROFILE", offender.profileId, "HARASSMENT");
    await new Promise((x) => setTimeout(x, 5));
    const r3 = await file("c@example.com", "REQUEST", req.id);

    const open = await get(admin.auth, "/admin/reports");
    expect(open.body.data.map((r: { id: string }) => r.id)).toEqual([r1, r2, r3]);
    expect(open.body.data.map((r: { openReportsOnTarget: number }) => r.openReportsOnTarget)).toEqual([2, 2, 1]);
    expect(open.body.data[0].reporter).toMatchObject({ name: "Viewer" });

    await post(admin.auth, `/admin/reports/${r1}/resolve`, { outcome: "DISMISSED", resolution: "not a violation" });
    expect((await get(admin.auth, "/admin/reports")).body.data.map((r: { id: string }) => r.id)).toEqual([r2, r3]);
    expect((await get(admin.auth, "/admin/reports", { status: "DISMISSED" })).body.data.map((r: { id: string }) => r.id)).toEqual([r1]);
    expect((await get(admin.auth, "/admin/reports", { status: "ALL" })).body.data.map((r: { id: string }) => r.id)).toEqual([r3, r2, r1]); // newest first
    expect((await get(admin.auth, "/admin/reports", { targetType: "REQUEST" })).body.data).toHaveLength(1);
    expect((await get(admin.auth, "/admin/reports", { status: "WHATEVER" })).status).toBe(422);
  });

  it("shows a report with the reported target in actionable terms, plus the moderation history", async () => {
    const offender = await playerUser(w, "offender@example.com", [{ sportId: w.football.id }]);
    const id = await file("a@example.com", "PLAYER_PROFILE", offender.profileId, "FAKE_PROFILE");
    await post(admin.auth, `/admin/players/${offender.profileId}/hide`, { reason: "checking" });

    const res = await get(admin.auth, `/admin/reports/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      reason: "FAKE_PROFILE",
      reporter: { name: "Viewer", email: "a@example.com" },
      target: { kind: "PLAYER_PROFILE", profileId: offender.profileId, userId: offender.user.id, hiddenByAdmin: true },
      targetMissing: false,
    });
    expect(res.body.data.history.map((h: { action: string }) => h.action)).toEqual(["PROFILE_HIDE"]);
    expect((await get(admin.auth, "/admin/reports/nope")).status).toBe(404);
  });

  it("describes request, rating and team targets, and notes when the target is gone", async () => {
    const poster = await signedIn("poster@example.com");
    const req = await makeRequest(w, poster.user.id, { venueText: "Dodgy ground" });
    const reqReport = await file("a@example.com", "REQUEST", req.id);
    expect((await get(admin.auth, `/admin/reports/${reqReport}`)).body.data.target).toMatchObject({ kind: "REQUEST", venueText: "Dodgy ground", posterId: poster.user.id });

    const m = await completedMatch(w, { players: 1, captainEmail: "capx@example.com" });
    const rating = await prisma.rating.create({ data: { requestId: m.request.id, raterId: m.cap.user.id, rateeId: m.players[0]!.user.id, direction: "CAPTAIN_TO_PLAYER", scores: {}, overall: 2, comment: "awful" } });
    const ratingReport = await file("b@example.com", "RATING", rating.id);
    expect((await get(admin.auth, `/admin/reports/${ratingReport}`)).body.data.target).toMatchObject({ kind: "RATING", comment: "awful", raterId: m.cap.user.id });

    await prisma.playerRequest.update({ where: { id: req.id }, data: { isHidden: false } });
    await prisma.report.update({ where: { id: reqReport }, data: { targetId: "deleted-thing" } });
    const gone = (await get(admin.auth, `/admin/reports/${reqReport}`)).body.data;
    expect(gone).toMatchObject({ target: null, targetMissing: true });
  });

  it("resolves or dismisses with a written outcome, once", async () => {
    const offender = await playerUser(w, "offender@example.com");
    const id = await file("a@example.com", "PLAYER_PROFILE", offender.profileId);
    expect((await post(admin.auth, `/admin/reports/${id}/resolve`, { outcome: "RESOLVED" })).status).toBe(422);
    expect((await post(admin.auth, `/admin/reports/${id}/resolve`, { outcome: "MAYBE", resolution: "hmm hmm" })).status).toBe(422);

    const res = await post(admin.auth, `/admin/reports/${id}/resolve`, { outcome: "RESOLVED", resolution: "profile hidden, user warned" });
    expect(res.body.data).toMatchObject({ status: "RESOLVED", resolvedById: admin.user.id, resolution: "profile hidden, user warned" });
    expect(res.body.data.resolvedAt).toBeTruthy();
    const again = await post(admin.auth, `/admin/reports/${id}/resolve`, { outcome: "DISMISSED", resolution: "changed my mind" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REPORT_ALREADY_RESOLVED");
    expect((await actions(id)).map((a) => a.action)).toEqual(["REPORT_RESOLVE"]);
  });

  it("two admins resolving at once: exactly one wins, one audit entry", async () => {
    const admin2 = await adminUser("admin2@example.com");
    const offender = await playerUser(w, "offender@example.com");
    const id = await file("a@example.com", "PLAYER_PROFILE", offender.profileId);
    const results = await Promise.all([
      post(admin.auth, `/admin/reports/${id}/resolve`, { outcome: "RESOLVED", resolution: "handled by one" }),
      post(admin2.auth, `/admin/reports/${id}/resolve`, { outcome: "DISMISSED", resolution: "handled by two" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await actions(id)).toHaveLength(1);
  });
});

describe("audit log", () => {
  it("records who did what, newest first, filterable by target", async () => {
    const u = await signedIn("target@example.com");
    const p = await playerUser(w, "player@example.com");
    await post(admin.auth, `/admin/users/${u.user.id}/suspend`, { reason: "spam accounts" });
    await post(admin.auth, `/admin/players/${p.profileId}/verify`, { verified: true });
    await put(admin.auth, "/admin/app-config/ads_enabled", { value: true });

    const all = await get(admin.auth, "/admin/actions");
    expect(all.body.data.map((a: { action: string }) => a.action)).toEqual(["CONFIG_SET", "PROFILE_VERIFY", "USER_SUSPEND"]);
    expect(all.body.data.every((a: { adminId: string }) => a.adminId === admin.user.id)).toBe(true);
    expect((await get(admin.auth, "/admin/actions", { targetId: u.user.id })).body.data).toHaveLength(1);
    expect((await get(admin.auth, "/admin/actions", { targetType: "CONFIG" })).body.data[0]).toMatchObject({ targetId: "ads_enabled", metadata: { from: false, to: true } });
    const page = await get(admin.auth, "/admin/actions", { limit: 2 });
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta.nextCursor).toBeTruthy();
  });
});

describe("app config (admin)", () => {
  it("reads all values with defaults and sets valid ones", async () => {
    expect((await get(admin.auth, "/admin/app-config")).body.data).toEqual({ ads_enabled: false, boost_enabled: false, min_app_version: "0.0.0", contact_credits_enabled: false, contact_free_per_day: 5, contact_credit_cost: 1, boost_credit_cost: 10, boost_hours: 48 });
    const res = await put(admin.auth, "/admin/app-config/min_app_version", { value: "1.4.0" });
    expect(res.body.data.min_app_version).toBe("1.4.0");
    await put(admin.auth, "/admin/app-config/ads_enabled", { value: true });
    expect((await api().get(`${V1}/app-config`)).body.data).toMatchObject({ flags: { ads_enabled: true, boost_enabled: false }, minAppVersion: "1.4.0" });
  });

  it("rejects unknown keys, wrong types and malformed versions — and extra body fields", async () => {
    expect((await put(admin.auth, "/admin/app-config/secret_flag", { value: true })).status).toBe(422);
    expect((await put(admin.auth, "/admin/app-config/ads_enabled", { value: "yes" })).status).toBe(422);
    expect((await put(admin.auth, "/admin/app-config/min_app_version", { value: true })).status).toBe(422);
    expect((await put(admin.auth, "/admin/app-config/min_app_version", { value: "latest" })).status).toBe(422);
    expect((await put(admin.auth, "/admin/app-config/ads_enabled", { value: true, extra: 1 })).status).toBe(422);
    expect(await prisma.appConfig.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

