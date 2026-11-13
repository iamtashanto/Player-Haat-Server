import { beforeEach, describe, expect, it } from "vitest";
import { expireStaleRequests } from "../src/modules/maintenance/expire-stale-requests.js";
import { purgeExpiredData } from "../src/modules/maintenance/purge-expired-data.js";
import { sweepOrphanUploads } from "../src/modules/maintenance/sweep-orphan-uploads.js";
import { STORAGE_PREFIX } from "../src/lib/storage/paths.js";
import { fakeStorage } from "./fake-storage.js";
import { hoursFromNow, makeApplication, makeRequest, playerUser, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

describe("expireStaleRequests", () => {
  it("cancels OPEN requests nobody was accepted for once the match is a day past, and closes pending applications", async () => {
    const cap = await signedIn("cap@example.com");
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const stale = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-25) });
    const app = await makeApplication(stale.id, p.user.id, "PENDING");

    expect(await expireStaleRequests()).toBe(1);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("CANCELLED");
    expect(await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ status: "REJECTED" });
  });

  it("leaves everything that still matters alone", async () => {
    const cap = await signedIn("cap@example.com");
    const recent = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-23) }); // inside the grace period
    const upcoming = await makeRequest(w, cap.user.id);
    const accepted = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-30), playersAccepted: 1 }); // poster must complete it
    const filled = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-30), status: "FILLED", playersAccepted: 2 });
    const completed = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-30), status: "COMPLETED" });
    const cancelled = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-30), status: "CANCELLED" });

    expect(await expireStaleRequests()).toBe(0);
    const statuses = await prisma.playerRequest.findMany({ select: { id: true, status: true } });
    const byId = Object.fromEntries(statuses.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ [recent.id]: "OPEN", [upcoming.id]: "OPEN", [accepted.id]: "OPEN", [filled.id]: "FILLED", [completed.id]: "COMPLETED", [cancelled.id]: "CANCELLED" });
  });

  it("is idempotent and works through more rows than one batch", async () => {
    const cap = await signedIn("cap@example.com");
    for (let i = 0; i < 7; i++) await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-48) });
    expect(await expireStaleRequests(new Date(), { batchSize: 3 })).toBe(7);
    expect(await expireStaleRequests()).toBe(0);
    expect(await prisma.playerRequest.count({ where: { status: "CANCELLED" } })).toBe(7);
  });

  it("never cancels a request that was accepted-into between the lookup and the update (the status guard re-checks)", async () => {
    const cap = await signedIn("cap@example.com");
    const r = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-48), playersAccepted: 0 });
    await prisma.playerRequest.update({ where: { id: r.id }, data: { playersAccepted: 1 } }); // someone got accepted
    expect(await expireStaleRequests()).toBe(0);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("OPEN");
  });
});

describe("purgeExpiredData", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  it("deletes refresh tokens a week past expiry (revoked or not) and keeps the rest — and the chain survives", async () => {
    const u = await signedIn("u@example.com");
    await prisma.refreshToken.deleteMany();
    const mk = (hash: string, over: { expiresAt: Date; revokedAt?: Date; replacedById?: string }) =>
      prisma.refreshToken.create({ data: { userId: u.user.id, tokenHash: hash, familyId: "f", ...over } });
    const alive = await mk("alive", { expiresAt: daysAgo(-10) });
    const justExpired = await mk("just-expired", { expiresAt: daysAgo(6) });
    await mk("old-revoked", { expiresAt: daysAgo(8), revokedAt: daysAgo(40) });
    // an old token whose successor is still alive: deleting it must not break the live one
    const successor = await mk("successor", { expiresAt: daysAgo(-5) });
    await mk("old-rotated", { expiresAt: daysAgo(9), revokedAt: daysAgo(9), replacedById: successor.id });

    const res = await purgeExpiredData();
    expect(res.refreshTokens).toBe(2);
    const left = (await prisma.refreshToken.findMany()).map((t) => t.id).sort();
    expect(left).toEqual([alive.id, justExpired.id, successor.id].sort());
  });

  it("deletes verification codes two days past expiry or use", async () => {
    await prisma.verificationCode.createMany({
      data: [
        { type: "EMAIL_VERIFY", target: "fresh@x.com", codeHash: "h", expiresAt: daysAgo(-1) },
        { type: "EMAIL_VERIFY", target: "expired-recent@x.com", codeHash: "h", expiresAt: daysAgo(1) },
        { type: "EMAIL_VERIFY", target: "expired-old@x.com", codeHash: "h", expiresAt: daysAgo(3) },
        { type: "PASSWORD_RESET", target: "used-old@x.com", codeHash: "h", expiresAt: daysAgo(-1), consumedAt: daysAgo(3) },
        { type: "PASSWORD_RESET", target: "used-recent@x.com", codeHash: "h", expiresAt: daysAgo(-1), consumedAt: daysAgo(1) },
      ],
    });
    expect((await purgeExpiredData()).verificationCodes).toBe(2);
    expect((await prisma.verificationCode.findMany()).map((c) => c.target).sort()).toEqual(["expired-recent@x.com", "fresh@x.com", "used-recent@x.com"]);
  });

  it("deletes notifications older than the retention window only", async () => {
    const u = await signedIn("u@example.com");
    await prisma.notification.createMany({
      data: [
        { userId: u.user.id, type: "SYSTEM", data: {}, createdAt: daysAgo(200) },
        { userId: u.user.id, type: "SYSTEM", data: {}, createdAt: daysAgo(100) },
        { userId: u.user.id, type: "SYSTEM", data: {} },
      ],
    });
    // anything past 90 days goes (the 200- and 100-day-old ones); today's stays
    expect((await purgeExpiredData()).notifications).toBe(2);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("deletes read alerts after 30 days but keeps unread ones until 90", async () => {
    const u = await signedIn("u@example.com");
    await prisma.notification.createMany({
      data: [
        { userId: u.user.id, type: "SYSTEM", data: {}, createdAt: daysAgo(45), readAt: daysAgo(44) }, // read and old: goes
        { userId: u.user.id, type: "SYSTEM", data: {}, createdAt: daysAgo(45) }, // unread: stays
        { userId: u.user.id, type: "SYSTEM", data: {}, createdAt: daysAgo(10), readAt: daysAgo(9) }, // read but recent: stays
      ],
    });
    expect((await purgeExpiredData()).notifications).toBe(1);
    expect(await prisma.notification.count()).toBe(2);
  });

  it("keeps only the newest 300 alerts per person, leaving other people alone", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const now = Date.now();
    await prisma.notification.createMany({ data: Array.from({ length: 320 }, (_, i) => ({ userId: a.user.id, type: "SYSTEM" as const, data: { n: i }, createdAt: new Date(now - i * 1000) })) });
    await prisma.notification.createMany({ data: Array.from({ length: 5 }, () => ({ userId: b.user.id, type: "SYSTEM" as const, data: {} })) });
    expect((await purgeExpiredData(new Date(), { chunk: 7 })).notifications).toBe(20);
    expect(await prisma.notification.count({ where: { userId: a.user.id } })).toBe(300);
    expect(await prisma.notification.count({ where: { userId: b.user.id } })).toBe(5);
    // the ones kept are the newest
    const oldest = await prisma.notification.findFirstOrThrow({ where: { userId: a.user.id }, orderBy: { createdAt: "asc" } });
    expect((oldest.data as { n: number }).n).toBe(299);
  });

  it("deletes profile views after 180 days", async () => {
    const rec = await signedIn("rec@example.com");
    const p = await signedIn("p@example.com");
    const profile = await prisma.playerProfile.create({ data: { userId: p.user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    await prisma.profileView.createMany({ data: [
      { profileId: profile.id, viewerId: rec.user.id, day: daysAgo(200), createdAt: daysAgo(200) },
      { profileId: profile.id, viewerId: rec.user.id, day: new Date(), createdAt: new Date() },
    ] });
    expect((await purgeExpiredData()).profileViews).toBe(1);
    expect(await prisma.profileView.count()).toBe(1);
  });

  it("works through more rows than one chunk, and a second run finds nothing", async () => {
    const u = await signedIn("u@example.com");
    await prisma.refreshToken.deleteMany();
    await prisma.refreshToken.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({ userId: u.user.id, tokenHash: `old-${i}`, familyId: "f", expiresAt: daysAgo(30) })),
    });
    expect((await purgeExpiredData(new Date(), { chunk: 4 })).refreshTokens).toBe(11);
    expect(await purgeExpiredData()).toEqual({ telemetry: 0, refreshTokens: 0, verificationCodes: 0, notifications: 0, pushLog: 0, profileViews: 0 });
  });
});

describe("sweepOrphanUploads", () => {
  const id = (name: string) => `${STORAGE_PREFIX}player-photos/someone/${name}`;

  it("deletes old uploads nothing references, and keeps referenced and recent ones", async () => {
    const u = await signedIn("u@example.com");
    const profile = await prisma.playerProfile.create({ data: { userId: u.user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id } });
    await prisma.team.create({ data: { name: "FC", captainId: u.user.id, sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, logoPublicId: id("logo") } });
    await prisma.user.update({ where: { id: u.user.id }, data: { avatarPublicId: id("avatar") } });
    await prisma.playerMedia.create({ data: { profileId: profile.id, type: "PHOTO", url: "u", publicId: id("photo") } });

    for (const name of ["orphan-1", "orphan-2", "avatar", "photo", "logo"]) fakeStorage.put(id(name), 48);
    fakeStorage.put(id("fresh-orphan"), 2); // too young to judge

    const res = await sweepOrphanUploads();
    expect(res).toEqual({ scanned: 5, deleted: 2 });
    expect([...fakeStorage.files.keys()].sort()).toEqual([id("avatar"), id("fresh-orphan"), id("logo"), id("photo")].sort());
    expect(fakeStorage.deleted.sort()).toEqual([id("orphan-1"), id("orphan-2")]);
  });

  it("only ever looks under this environment's prefix, so another environment's assets are untouchable", async () => {
    const foreign = "playerhaat/production/player-photos/x/theirs";
    fakeStorage.put(foreign, 500);
    fakeStorage.put(id("mine"), 500);
    await sweepOrphanUploads();
    expect(fakeStorage.listCalls[0]!.prefix).toBe(STORAGE_PREFIX);
    expect(fakeStorage.files.has(foreign)).toBe(true);
    expect(fakeStorage.files.has(id("mine"))).toBe(false);
  });

  it("one failed delete doesn't stop the others and is retried next run", async () => {
    for (const n of ["a", "b", "c"]) fakeStorage.put(id(n), 48);
    fakeStorage.failDeleteIds.add(id("b"));
    expect(await sweepOrphanUploads()).toEqual({ scanned: 3, deleted: 2 });
    expect(fakeStorage.files.has(id("b"))).toBe(true);
    fakeStorage.failDeleteIds.clear();
    expect(await sweepOrphanUploads()).toEqual({ scanned: 1, deleted: 1 });
  });

  it("is bounded per run and does nothing when storage isn't configured", async () => {
    for (let i = 0; i < 5; i++) fakeStorage.put(id(`o${i}`), 48);
    expect((await sweepOrphanUploads(new Date(), { maxScan: 2 })).scanned).toBe(2);
    fakeStorage.notConfigured = true;
    expect(await sweepOrphanUploads()).toEqual({ scanned: 0, deleted: 0, skipped: "storage-not-configured" });
  });

  it("honours the minimum age", async () => {
    fakeStorage.put(id("ten-hours"), 10);
    expect((await sweepOrphanUploads()).deleted).toBe(0);
    expect((await sweepOrphanUploads(new Date(), { minAgeHours: 5 })).deleted).toBe(1);
  });
});
