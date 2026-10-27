import { beforeEach, describe, expect, it } from "vitest";
import { sendFollowupRatingReminders } from "../src/modules/ratings/rating-reminders.js";
import { fakePush } from "./fake-push.js";
import { V1, api, bearer, completedMatch, prisma, resetDb, seedWorld, settle, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const reminders = () => prisma.notification.findMany({ where: { type: "RATING_REMINDER" } });
const run = async () => {
  const n = await sendFollowupRatingReminders();
  await settle();
  return n;
};

describe("follow-up rating reminders", () => {
  it("reminds the captain and every player who hasn't rated, once the match has been completed for 3+ days", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2, completedHoursAgo: 4 * 24 });
    expect(await run()).toBe(3);
    const rows = await reminders();
    expect(rows.map((r) => r.userId).sort()).toEqual([cap.user.id, ...players.map((p) => p.user.id)].sort());
    expect(rows.every((r) => (r.data as { kind: string; requestId: string }).kind === "followup" && (r.data as { requestId: string }).requestId === request.id)).toBe(true);
  });

  it("sends each person at most one follow-up per match", async () => {
    await completedMatch(w, { players: 1, completedHoursAgo: 4 * 24 });
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);
    expect(await reminders()).toHaveLength(2);
  });

  it("leaves out matches that are too fresh (<3 days) or past the window (>7 days)", async () => {
    await completedMatch(w, { players: 1, completedHoursAgo: 2 * 24 });
    expect(await run()).toBe(0);
    await resetDb();
    w = await seedWorld();
    await completedMatch(w, { players: 1, completedHoursAgo: 8 * 24 });
    expect(await run()).toBe(0);
  });

  it("skips people who already rated, players struck as no-shows, and a captain with nobody left to rate", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 2, completedHoursAgo: 4 * 24 });
    const [p0, p1] = players as [(typeof players)[number], (typeof players)[number]];
    // captain rates p0 (a normal review) and strikes p1; p0 rates the captain
    await api().post(`${V1}/requests/${request.id}/ratings`).set(cap.auth).send({ applicationId: p0.app.id, scores: { skill: 4, punctuality: 4, behavior: 4 } });
    await api().post(`${V1}/requests/${request.id}/ratings`).set(cap.auth).send({ applicationId: p1.app.id, noShow: true });
    await api().post(`${V1}/requests/${request.id}/ratings`).set(p0.auth).send({ scores: { behavior: 5, organization: 5 } });
    await settle();
    await prisma.notification.deleteMany();

    // p0 done; p1 is struck (can't rate); the captain has rated everyone → nobody to remind
    expect(await run()).toBe(0);
  });

  it("only the captain is left to remind when every player has rated", async () => {
    const { cap, request, players } = await completedMatch(w, { players: 1, completedHoursAgo: 4 * 24 });
    await api().post(`${V1}/requests/${request.id}/ratings`).set(players[0]!.auth).send({ scores: { behavior: 5, organization: 5 } });
    expect(await run()).toBe(1);
    expect((await reminders())[0]!.userId).toBe(cap.user.id);
  });

  it("skips suspended users", async () => {
    const { players } = await completedMatch(w, { players: 1, completedHoursAgo: 4 * 24 });
    await prisma.user.update({ where: { id: players[0]!.user.id }, data: { status: "SUSPENDED" } });
    expect(await run()).toBe(1); // just the captain
  });

  it("pushes in the reader's language and writes the inbox row", async () => {
    const { players } = await completedMatch(w, { players: 1, completedHoursAgo: 4 * 24 });
    const tok = "r".repeat(30);
    await prisma.deviceToken.create({ data: { userId: players[0]!.user.id, token: tok, platform: "ANDROID" } });
    await prisma.user.update({ where: { id: players[0]!.user.id }, data: { locale: "en" } });
    await run();
    expect(fakePush.to(tok)[0]).toMatchObject({ title: "How was the match? Leave a rating", data: { type: "RATING_REMINDER", kind: "followup" } });
    const inbox = await api().get(`${V1}/notifications`).set(bearer(players[0]!.accessToken));
    expect(inbox.body.data[0]).toMatchObject({ type: "RATING_REMINDER", title: "How was the match? Leave a rating" });
  });

  it("is safe to run on two instances at once: a held advisory lock means the second run does nothing", async () => {
    await completedMatch(w, { players: 1, completedHoursAgo: 4 * 24 });
    let heldResult: number | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rating-reminders'))`; // "instance A" is mid-run
      heldResult = await sendFollowupRatingReminders(); // "instance B" arrives
    });
    expect(heldResult).toBe(0);
    expect(await reminders()).toHaveLength(0);
    expect(await run()).toBe(2); // once A is done, work proceeds normally
  });

  it("two simultaneous runs never double-send", async () => {
    await completedMatch(w, { players: 2, completedHoursAgo: 4 * 24 });
    const [a, b] = await Promise.all([sendFollowupRatingReminders(), sendFollowupRatingReminders()]);
    await settle();
    expect(a + b).toBe(3);
    expect(await reminders()).toHaveLength(3);
  });
});
