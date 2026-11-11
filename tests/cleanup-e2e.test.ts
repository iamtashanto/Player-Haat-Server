import { beforeEach, describe, expect, it } from "vitest";
import { cleanupE2eData } from "../src/lib/e2e-cleanup.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG } from "./images.js";
import { V1, api, completedMatch, makeApplication, makeRequest, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const deps = (dryRun = false) => ({ dryRun, deleteFile: (p: string) => fakeStorage.deleteImage(p) });

async function e2ePlayerWithEverything() {
  const p = await playerUser(w, "player-x1@e2e.test", [{ sportId: w.football.id }]);
  const img = (path: string, m: "put" | "post") => api()[m](`${V1}${path}`).set(p.auth).attach("file", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
  await img("/users/me/avatar", "put");
  await img("/players/me/media/cover", "put");
  await img("/players/me/media/photos", "post");
  await api().post(`${V1}/verification/files`).set(p.auth).attach("file", JPEG, { filename: "d.jpg", contentType: "image/jpeg" });
  return p;
}

describe("e2e data cleanup", () => {
  it("deletes e2e accounts, what they own (requests, teams, applications, ratings) and their files — and never a real user", async () => {
    const p = await e2ePlayerWithEverything();
    const rec = await recruiterUser(w, "rec-x1@e2e.test");
    const real = await playerUser(w, "real@example.com", [{ sportId: w.football.id }]);
    const realRec = await recruiterUser(w, "real-rec@example.com");
    const r = await makeRequest(w, rec.user.id);
    await makeApplication(r.id, p.user.id, "ACCEPTED");
    await makeApplication(r.id, real.user.id, "PENDING"); // a real player applied to an e2e recruiter's game
    await prisma.team.create({ data: { name: "E2E FC", sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, captainId: p.user.id } });
    const done = await completedMatch(w, { captainEmail: "cap-x1@e2e.test" });
    expect(done).toBeTruthy();
    const realGame = await makeRequest(w, realRec.user.id);
    await makeApplication(realGame.id, real.user.id, "ACCEPTED");
    const filesBefore = fakeStorage.files.size;
    expect(filesBefore).toBeGreaterThan(0);

    const report = await cleanupE2eData(deps());
    expect(report.users).toBeGreaterThanOrEqual(3);
    expect(report.filesFailed).toBe(0);
    expect(await prisma.user.count({ where: { email: { endsWith: "@e2e.test" } } })).toBe(0);
    expect(fakeStorage.files.size).toBe(0);
    expect(fakeStorage.texts.size).toBe(0);
    expect(await prisma.verificationFile.count()).toBe(0);
    expect(await prisma.mediaAsset.count()).toBe(0);

    // the real users and their own data are intact
    expect(await prisma.user.findMany({ where: { email: { in: ["real@example.com", "real-rec@example.com"] } } })).toHaveLength(2);
    expect(await prisma.playerProfile.count({ where: { userId: real.user.id } })).toBe(1);
    expect(await prisma.playerRequest.findUnique({ where: { id: realGame.id } })).not.toBeNull();
    expect(await prisma.application.count({ where: { playerId: real.user.id } })).toBe(1); // only the one to a real game
  });

  it("--dry-run counts and changes nothing; a second real run finds nothing", async () => {
    await e2ePlayerWithEverything();
    const before = fakeStorage.files.size;
    const lines: string[] = [];
    const dry = await cleanupE2eData({ ...deps(true), log: (l) => lines.push(l) });
    expect(dry).toMatchObject({ users: 1, files: 4 });
    expect(lines[0]).toContain("[dry-run]");
    expect(await prisma.user.count()).toBe(1);
    expect(fakeStorage.files.size).toBe(before);

    expect(await cleanupE2eData(deps())).toMatchObject({ users: 1, filesDeleted: 4 });
    expect(await cleanupE2eData(deps())).toMatchObject({ users: 0, files: 0 });
  });

  it("only the reserved @e2e.test domain counts (look-alikes are real users)", async () => {
    for (const email of ["a@e2e.test.com", "e2e.test@example.com", "a@xe2e.test", "a@notE2E.test.org"]) await playerUser(w, email, []);
    await playerUser(w, "UPPER@E2E.TEST", []);
    const report = await cleanupE2eData(deps());
    expect(report.users).toBe(1);
    expect(await prisma.user.count()).toBe(4);
  });

  it("a file that can't be deleted is reported and the database step still completes", async () => {
    await e2ePlayerWithEverything();
    fakeStorage.failDeletes = true;
    const lines: string[] = [];
    const r = await cleanupE2eData({ ...deps(), log: (l) => lines.push(l) });
    expect(r.filesFailed).toBe(4);
    expect(lines.some((l) => l.startsWith("file not deleted"))).toBe(true);
    expect(await prisma.user.count()).toBe(0);
  });
});
