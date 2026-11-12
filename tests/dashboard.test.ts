import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, completedMatch, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, recruiterUser, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const dash = (a: Auth, role?: string) => api().get(`${V1}/dashboard${role ? `?role=${role}` : ""}`).set(a);

describe("player dashboard", () => {
  it("a new account with no profile gets an honest empty dashboard", async () => {
    const u = await signedIn("fresh@example.com");
    const res = await dash(u.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role: "PLAYER",
      profile: { exists: false, completeness: { percent: 0 } },
      reliability: { gamesPlayed: 0, noShows: 0, attendanceRate: null },
      rating: { isNew: true, count: 0 },
      upcoming: [],
      applications: { pending: 0 },
      invites: { pending: 0 },
      credits: 0,
    });
  });

  it("completeness is a checklist: each thing added moves the percentage and drops off the missing list", async () => {
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const before = (await dash(p.auth)).body.data.profile;
    expect(before.exists).toBe(true);
    expect(before.completeness.missing).toEqual(expect.arrayContaining(["photo", "cover", "bio", "gallery", "video", "availability", "achievement", "verification"]));

    await prisma.user.update({ where: { id: p.user.id }, data: { avatarUrl: "https://example.test/a.jpg" } });
    await prisma.playerProfile.update({ where: { id: p.profileId }, data: { bio: "Striker from Kalapara" } });
    await prisma.playerMedia.create({ data: { profileId: p.profileId, type: "PHOTO", url: "https://example.test/p.jpg", publicId: "x/p" } });
    const after = (await dash(p.auth)).body.data.profile.completeness;
    expect(after.missing).not.toContain("photo");
    expect(after.missing).not.toContain("bio");
    expect(after.missing).not.toContain("gallery");
    expect(after.percent).toBeGreaterThan(before.completeness.percent);
    expect(after.percent).toBe(Math.round((3 / 8) * 100));
  });

  it("shows games I am accepted into (soonest first), pending applications, invites and reviews to give", async () => {
    const cap = await recruiterUser(w, "cap@example.com");
    const p = await playerUser(w, "pl@example.com", [{ sportId: w.football.id }]);
    const soon = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(30), venueText: "Soon Ground" });
    const later = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(90), venueText: "Later Ground" });
    const other = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(50), venueText: "Pending Ground" });
    await makeApplication(later.id, p.user.id, "ACCEPTED");
    await makeApplication(soon.id, p.user.id, "ACCEPTED");
    await makeApplication(other.id, p.user.id, "PENDING");
    await prisma.invite.create({ data: { recruiterId: cap.user.id, profileId: p.profileId, status: "PENDING" } });
    await prisma.invite.create({ data: { recruiterId: cap.user.id, profileId: p.profileId, status: "DECLINED" } });

    const d = (await dash(p.auth)).body.data;
    expect(d.upcoming.map((g: { venueText: string }) => g.venueText)).toEqual(["Soon Ground", "Later Ground"]);
    expect(d.applications.pending).toBe(1);
    expect(d.invites.pending).toBe(1); // the declined one is not counted
  });

  it("reliability and reviews follow what really happened", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2 });
    const [a, b] = players;
    await prisma.application.update({ where: { id: a!.app.id }, data: { attendance: "ATTENDED", attendanceMarkedAt: new Date() } });
    await prisma.application.update({ where: { id: b!.app.id }, data: { attendance: "NO_SHOW", attendanceMarkedAt: new Date() } });
    const da = (await dash(a!.auth)).body.data;
    expect(da.reliability).toMatchObject({ gamesPlayed: 1, noShows: 0, attendanceRate: 1 });
    expect(da.reviewsToGive).toBe(1); // the finished game still needs the captain rated
    const db = (await dash(b!.auth)).body.data;
    expect(db.reliability).toMatchObject({ gamesPlayed: 0, noShows: 1, attendanceRate: 0 });
    void cap; void request;
  });

  it("a profile viewed this week counts the views, and old views do not", async () => {
    const p = await playerUser(w, "viewed@example.com", [{ sportId: w.football.id }]);
    const v1 = await signedIn("v1@example.com");
    const v2 = await signedIn("v2@example.com");
    await prisma.profileView.create({ data: { profileId: p.profileId, viewerId: v1.user.id, day: new Date() } });
    await prisma.profileView.create({ data: { profileId: p.profileId, viewerId: v2.user.id, day: new Date(), createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    expect((await dash(p.auth)).body.data.views.last7Days).toBe(1);
  });
});

describe("organiser dashboard", () => {
  it("counts open games and pending applicants, and lists upcoming games with who is waiting", async () => {
    const cap = await recruiterUser(w, "cap@example.com");
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const b = await playerUser(w, "b@example.com", [{ sportId: w.football.id }]);
    const g1 = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(24), playersNeeded: 4 });
    const g2 = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(72), playersNeeded: 2 });
    await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(48), status: "CANCELLED" });
    await makeApplication(g1.id, a.user.id, "PENDING");
    await makeApplication(g1.id, b.user.id, "PENDING");
    await makeApplication(g2.id, a.user.id, "ACCEPTED");

    const d = (await dash(cap.auth)).body.data;
    expect(d.role).toBe("RECRUITER");
    expect(d.profile.id).toBe(cap.recruiterId);
    expect(d.games.open).toBe(2); // the cancelled game is not open
    expect(d.applicants.pending).toBe(2);
    expect(d.games.upcoming).toHaveLength(2);
    expect(d.games.upcoming[0]).toMatchObject({ id: g1.id, playersNeeded: 4, pendingApplicants: 2 });
    expect(d.games.upcoming[1]).toMatchObject({ id: g2.id, pendingApplicants: 0 });
  });

  it("lists played games that still need attendance, and a game drops off once everyone is marked", async () => {
    const cap = await recruiterUser(w, "cap2@example.com");
    const a = await playerUser(w, "a2@example.com", [{ sportId: w.football.id }]);
    const b = await playerUser(w, "b2@example.com", [{ sportId: w.football.id }]);
    const g = await makeRequest(w, cap.user.id, { status: "FILLED", matchAt: hoursFromNow(-5), playersNeeded: 2, playersAccepted: 2 });
    const appA = await makeApplication(g.id, a.user.id, "ACCEPTED");
    const appB = await makeApplication(g.id, b.user.id, "ACCEPTED");
    let d = (await dash(cap.auth)).body.data;
    expect(d.games.needAttendance).toEqual([expect.objectContaining({ id: g.id, unmarked: 2 })]);

    await prisma.application.update({ where: { id: appA.id }, data: { attendance: "ATTENDED", attendanceMarkedAt: new Date() } });
    d = (await dash(cap.auth)).body.data;
    expect(d.games.needAttendance[0].unmarked).toBe(1);
    await prisma.application.update({ where: { id: appB.id }, data: { attendance: "NO_SHOW", attendanceMarkedAt: new Date() } });
    d = (await dash(cap.auth)).body.data;
    expect(d.games.needAttendance).toEqual([]);
  });

  it("90-day stats: fill rate and no-show rate from real games, null when there is nothing to divide", async () => {
    const cap = await recruiterUser(w, "cap3@example.com");
    expect((await dash(cap.auth)).body.data.stats90).toEqual({ gamesHosted: 0, fillRate: null, noShowRate: null });
    const a = await playerUser(w, "a3@example.com", [{ sportId: w.football.id }]);
    const b = await playerUser(w, "b3@example.com", [{ sportId: w.football.id }]);
    const g = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-30), playersNeeded: 4, playersAccepted: 2 });
    await prisma.playerRequest.update({ where: { id: g.id }, data: { completedAt: hoursFromNow(-26) } });
    await prisma.application.create({ data: { requestId: g.id, playerId: a.user.id, status: "ACCEPTED", attendance: "ATTENDED", attendanceMarkedAt: new Date() } });
    await prisma.application.create({ data: { requestId: g.id, playerId: b.user.id, status: "ACCEPTED", attendance: "NO_SHOW", attendanceMarkedAt: new Date() } });
    const s = (await dash(cap.auth)).body.data.stats90;
    expect(s).toEqual({ gamesHosted: 1, fillRate: 0.5, noShowRate: 0.5 });
  });

  it("shortlist, invites, credits and rating summary are mine only", async () => {
    const cap = await recruiterUser(w, "cap4@example.com");
    const other = await recruiterUser(w, "other@example.com");
    const p = await playerUser(w, "p4@example.com", [{ sportId: w.football.id }]);
    await prisma.shortlistEntry.create({ data: { recruiterId: cap.user.id, profileId: p.profileId } });
    await prisma.shortlistEntry.create({ data: { recruiterId: other.user.id, profileId: p.profileId } });
    await prisma.invite.create({ data: { recruiterId: cap.user.id, profileId: p.profileId, status: "PENDING" } });
    await prisma.invite.create({ data: { recruiterId: cap.user.id, profileId: p.profileId, status: "ACCEPTED" } });
    await prisma.user.update({ where: { id: cap.user.id }, data: { creditBalance: 7 } });
    const d = (await dash(cap.auth)).body.data;
    expect(d.shortlist.count).toBe(1);
    expect(d.invites).toEqual({ pending: 1, accepted: 1 });
    expect(d.credits).toBe(7);
    expect(d.rating).toMatchObject({ isNew: true, count: 0 });
  });
});

describe("access", () => {
  it("needs sign-in, and an admin gets a clear 403 rather than an empty page", async () => {
    expect((await api().get(`${V1}/dashboard`)).status).toBe(401);
    const admin = await adminUser();
    const res = await dash(admin.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_FORBIDDEN"); // the app-user guard turns admins away first
  });

  it("a person acting as the other role gets that role's dashboard", async () => {
    const r = await recruiterUser(w, "both@example.com");
    expect((await dash(r.auth, "PLAYER")).body.data.role).toBe("PLAYER");
    expect((await dash(r.auth)).body.data.role).toBe("RECRUITER");
  });
});
