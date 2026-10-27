import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, completedMatch, makeRequest, playerUser, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const report = (a: Auth, body: object) => api().post(`${V1}/reports`).set(a).send(body);

describe("POST /reports", () => {
  it("reports a player profile, a request, a team and a rating", async () => {
    const reporter = await signedIn("reporter@example.com");
    const offender = await playerUser(w, "offender@example.com", [{ sportId: w.football.id }]);
    const request = await makeRequest(w, offender.user.id);
    const team = await prisma.team.create({ data: { name: "FC", captainId: offender.user.id, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    const m = await completedMatch(w, { players: 1 });
    const rating = await prisma.rating.create({ data: { requestId: m.request.id, raterId: m.cap.user.id, rateeId: m.players[0]!.user.id, direction: "CAPTAIN_TO_PLAYER", scores: {}, overall: 3, comment: "rude" } });

    const targets = [
      ["PLAYER_PROFILE", offender.profileId],
      ["REQUEST", request.id],
      ["TEAM", team.id],
      ["RATING", rating.id],
    ] as const;
    for (const [targetType, targetId] of targets) {
      const res = await report(reporter.auth, { targetType, targetId, reason: "SPAM" });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: "OPEN" });
    }
    const rows = await prisma.report.findMany();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.reporterId === reporter.user.id && r.status === "OPEN")).toBe(true);
  });

  it("stores the reason and details; OTHER needs an explanation", async () => {
    const reporter = await signedIn("reporter@example.com");
    const offender = await playerUser(w, "offender@example.com");
    const ok = await report(reporter.auth, { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "FAKE_PROFILE", details: " photo is a celebrity " });
    expect(ok.status).toBe(201);
    expect(await prisma.report.findFirstOrThrow()).toMatchObject({ reason: "FAKE_PROFILE", details: "photo is a celebrity" });

    const other = await report(reporter.auth, { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "OTHER" });
    expect(other.status).toBe(422);
    expect((await report(reporter.auth, { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "OTHER", details: "abc" })).status).toBe(422);
    expect((await report(reporter.auth, { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "OTHER", details: "asked me to pay upfront" })).status).toBe(409); // dup of the first
  });

  it("can't report your own content", async () => {
    const me = await playerUser(w, "me@example.com", [{ sportId: w.football.id }]);
    const mine = await makeRequest(w, me.user.id);
    const team = await prisma.team.create({ data: { name: "FC", captainId: me.user.id, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    const m = await completedMatch(w, { players: 1 });
    const myRating = await prisma.rating.create({ data: { requestId: m.request.id, raterId: m.cap.user.id, rateeId: m.players[0]!.user.id, direction: "CAPTAIN_TO_PLAYER", scores: {}, overall: 3 } });
    for (const [targetType, targetId, auth] of [
      ["PLAYER_PROFILE", me.profileId, me.auth],
      ["REQUEST", mine.id, me.auth],
      ["TEAM", team.id, me.auth],
      ["RATING", myRating.id, m.cap.auth], // authored by the reporter
    ] as const) {
      const res = await report(auth, { targetType, targetId, reason: "SPAM" });
      expect(res.status).toBe(422);
    }
    expect(await prisma.report.count()).toBe(0);
  });

  it("404s on unknown targets and on requests hidden from the reporter", async () => {
    const reporter = await signedIn("reporter@example.com");
    const poster = await signedIn("poster@example.com");
    const hidden = await makeRequest(w, poster.user.id, { isHidden: true });
    for (const [targetType, targetId] of [["PLAYER_PROFILE", "nope"], ["REQUEST", "nope"], ["TEAM", "nope"], ["RATING", "nope"], ["REQUEST", hidden.id]] as const) {
      const res = await report(reporter.auth, { targetType, targetId, reason: "SPAM" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REPORT_TARGET_NOT_FOUND");
    }
  });

  it("allows one open report per person per target, but a new one once it's been handled", async () => {
    const reporter = await signedIn("reporter@example.com");
    const other = await signedIn("other@example.com");
    const offender = await playerUser(w, "offender@example.com");
    const body = { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "HARASSMENT" };
    expect((await report(reporter.auth, body)).status).toBe(201);
    const dup = await report(reporter.auth, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("REPORT_EXISTS");
    expect((await report(other.auth, body)).status).toBe(201); // someone else can still report it

    await prisma.report.updateMany({ where: { reporterId: reporter.user.id }, data: { status: "RESOLVED" } });
    expect((await report(reporter.auth, body)).status).toBe(201);
  });

  it("rejects USER targets (ids are never exposed), unknown reasons, extra fields; needs auth", async () => {
    const reporter = await signedIn("reporter@example.com");
    const offender = await playerUser(w, "offender@example.com");
    const base = { targetType: "PLAYER_PROFILE", targetId: offender.profileId, reason: "SPAM" };
    expect((await report(reporter.auth, { ...base, targetType: "USER", targetId: offender.user.id })).status).toBe(422);
    expect((await report(reporter.auth, { ...base, reason: "BORING" })).status).toBe(422);
    expect((await report(reporter.auth, { ...base, status: "RESOLVED" })).status).toBe(422);
    expect((await report(reporter.auth, { ...base, reporterId: "x" })).status).toBe(422);
    expect((await api().post(`${V1}/reports`).send(base)).status).toBe(401);
  });
});
