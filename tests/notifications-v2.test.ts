import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/lib/clock.js";
import { MAX_ATTEMPTS, backoffMs, processDue } from "../src/modules/notifications/queue.js";
import { inQuietHours, quietEnds } from "../src/modules/notifications/preferences.js";
import { NEARBY_PER_DAY, notifyNearbyAvailable, sendGameReminders } from "../src/modules/notifications/triggers.js";
import { notify } from "../src/modules/notifications/notifier.js";
import { fakePush } from "./fake-push.js";
import { V1, adminUser, api, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, recruiterUser, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
const realNow = clock.now;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
afterEach(() => {
  clock.now = realNow;
});

/** Dhaka wall-clock `hh:mm` today (the suite's clock is pinned to noon Dhaka) as an instant. */
const at = (hh: number, mm = 0, dayOffset = 0) => {
  const noon = realNow();
  return new Date(noon.getTime() - 12 * 3_600_000 + hh * 3_600_000 + mm * 60_000 + dayOffset * 86_400_000);
};
const get = (a: Auth, path: string, q: object = {}) => api().get(`${V1}${path}`).set(a).query(q);
const put = (a: Auth, path: string, body: object) => api().put(`${V1}${path}`).set(a).send(body);
const del = (a: Auth, path: string) => api().delete(`${V1}${path}`).set(a);
const device = async (userId: string, n: string) => {
  await prisma.user.update({ where: { id: userId }, data: { locale: "en" } }); // assertions read the English copy
  const token = `fcm-${n}-`.padEnd(30, "x");
  await prisma.deviceToken.create({ data: { userId, token, platform: "ANDROID" } });
  return token;
};
const ping = (userId: string, type: Parameters<typeof notify>[0]["type"] = "NEW_APPLICANT", data: Record<string, string> = { requestId: "r1" }) =>
  notify({ userIds: [userId], type, data, params: { sport: { bn: "ফুটবল", en: "Football" }, venue: "Ground" } });

describe("preferences", () => {
  it("default to everything on, quiet hours 23:00–07:00 Dhaka, chat not exempt", async () => {
    const { auth } = await signedIn();
    expect((await get(auth, "/notifications/preferences")).body.data).toEqual({ games: true, messages: true, recruitment: true, system: true, nearbyAvailable: true, quietHoursEnabled: true, quietStart: "23:00", quietEnd: "07:00", chatInQuietHours: false });
  });

  it("saves only what is sent, per user, and validates", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const res = await put(a.auth, "/notifications/preferences", { games: false, quietStart: "22:30" });
    expect(res.body.data).toMatchObject({ games: false, quietStart: "22:30", messages: true, quietEnd: "07:00" });
    expect((await get(b.auth, "/notifications/preferences")).body.data.games).toBe(true);
    for (const bad of [{}, { quietStart: "25:00" }, { quietEnd: "7am" }, { games: "yes" }, { unknown: true }]) expect((await put(a.auth, "/notifications/preferences", bad)).status).toBe(422);
    expect((await api().get(`${V1}/notifications/preferences`)).status).toBe(401);
  });

  it("quiet-hours arithmetic handles the wrap past midnight", () => {
    const p = { quietHoursEnabled: true, quietStart: "23:00", quietEnd: "07:00" };
    expect(inQuietHours(at(23, 30), p)).toBe(true);
    expect(inQuietHours(at(3), p)).toBe(true);
    expect(inQuietHours(at(7), p)).toBe(false);
    expect(inQuietHours(at(12), p)).toBe(false);
    expect(inQuietHours(at(3), { ...p, quietHoursEnabled: false })).toBe(false);
    expect(quietEnds(at(23, 30), p).toISOString()).toBe(at(7, 0, 1).toISOString());
    expect(quietEnds(at(3), p).toISOString()).toBe(at(7).toISOString());
  });
});

describe("what a push respects", () => {
  it("a switched-off group: the inbox keeps the message, the push is skipped and logged", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    await prisma.notificationPreference.create({ data: { userId: user.id, games: false } });
    ping(user.id);
    await settle();
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
    expect(fakePush.to(tok)).toHaveLength(0);
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "SKIPPED", skipReason: "CATEGORY_OFF" });
  });

  it("quiet hours hold the push until they end — then it goes out", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    clock.now = () => at(23, 30);
    ping(user.id);
    await settle();
    expect(fakePush.to(tok)).toHaveLength(0);
    const job = await prisma.pushJob.findFirstOrThrow();
    expect(job.status).toBe("PENDING");
    expect(job.nextAttemptAt.toISOString()).toBe(at(7, 0, 1).toISOString());
    expect(await prisma.notification.count()).toBe(1); // the inbox row is immediate

    expect(await processDue(at(6, 59, 1))).toBe(0); // not yet
    expect(await processDue(at(7, 1, 1))).toBe(1);
    expect(fakePush.to(tok)).toHaveLength(1);
    expect((await prisma.pushJob.findFirstOrThrow()).status).toBe("SENT");
  });

  it("chat gets through quiet hours only if the user allows it", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const ta = await device(a.user.id, "a");
    const tb = await device(b.user.id, "b");
    await prisma.notificationPreference.create({ data: { userId: b.user.id, chatInQuietHours: true } });
    clock.now = () => at(2);
    notify({ userIds: [a.user.id, b.user.id], type: "NEW_MESSAGE", data: { conversationId: "c1" }, params: { actor: "Rafi", text: "hi" } });
    await settle();
    expect(fakePush.to(ta)).toHaveLength(0);
    expect(fakePush.to(tb)).toHaveLength(1);
  });

  it("turning quiet hours off sends at night", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    await prisma.notificationPreference.create({ data: { userId: user.id, quietHoursEnabled: false } });
    clock.now = () => at(2);
    ping(user.id);
    await settle();
    expect(fakePush.to(tok)).toHaveLength(1);
  });

  it("each push carries the screen it opens (link) and the type", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    ping(user.id, "NEW_APPLICANT", { requestId: "req-9" });
    ping(user.id, "NEW_MESSAGE", { conversationId: "conv-3" });
    ping(user.id, "GAME_MESSAGE", { gameId: "g-4" });
    await settle();
    const data = fakePush.sent.filter((s) => s.tokens.includes(tok)).map((s) => s.message.data);
    expect(data.map((d) => [d.type, d.link])).toEqual(expect.arrayContaining([["NEW_APPLICANT", "/request/req-9"], ["NEW_MESSAGE", "/chat/conv-3"], ["GAME_MESSAGE", "/games/g-4/chat"]]));
  });
});

describe("queue: retry with backoff, and the log", () => {
  it("a failing send is retried with growing delays, then marked FAILED", async () => {
    const { user } = await signedIn();
    await device(user.id, "a");
    fakePush.fail = true;
    const start = realNow();
    ping(user.id);
    await settle();
    let job = await prisma.pushJob.findFirstOrThrow();
    expect(job).toMatchObject({ status: "PENDING", attempts: 1, lastError: "FCM unavailable" });
    expect(job.nextAttemptAt.getTime() - start.getTime()).toBe(backoffMs(1));

    let t = start.getTime();
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      t += backoffMs(i - 1);
      expect(await processDue(new Date(t - 1000))).toBe(0); // not before the backoff has passed
      expect(await processDue(new Date(t))).toBe(1);
      job = await prisma.pushJob.findFirstOrThrow();
      expect(job.attempts).toBe(i);
      expect(job.status).toBe(i === MAX_ATTEMPTS ? "FAILED" : "PENDING");
    }
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
    expect(await processDue(new Date(t + 86_400_000))).toBe(0); // FAILED is final
  });

  it("a retry that succeeds is logged as SENT with the device counts", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    fakePush.fail = true;
    ping(user.id);
    await settle();
    fakePush.fail = false;
    await processDue(new Date(realNow().getTime() + backoffMs(1)));
    expect(fakePush.to(tok)).toHaveLength(1);
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "SENT", attempts: 2, deviceCount: 1, deliveredCount: 1, lastError: null });
  });

  it("dead tokens are removed and not counted as delivered", async () => {
    const { user } = await signedIn();
    const dead = await device(user.id, "dead");
    await device(user.id, "alive");
    fakePush.deadTokens.add(dead);
    ping(user.id);
    await settle();
    expect(await prisma.deviceToken.count()).toBe(1);
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "SENT", deviceCount: 2, deliveredCount: 1 });
  });

  it("two workers never send the same job twice", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    clock.now = () => at(2);
    ping(user.id);
    await settle();
    const later = at(8, 0, 1);
    await Promise.all([processDue(later), processDue(later), processDue(later)]);
    expect(fakePush.to(tok)).toHaveLength(1);
  });

  it("a worker that crashed mid-send leaves the job to be released and sent", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    await prisma.pushJob.create({ data: { userId: user.id, type: "SYSTEM", payload: {}, status: "SENDING", attempts: 1, nextAttemptAt: new Date(realNow().getTime() - 1000) } });
    const { runQueue } = await import("../src/modules/notifications/queue.js");
    expect(await runQueue()).toMatchObject({ released: 1 });
    expect(fakePush.to(tok)).toHaveLength(1);
  });

  it("a reminder that would arrive after the game is dropped, not sent late", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    await prisma.pushJob.create({ data: { userId: user.id, type: "GAME_REMINDER", payload: {}, expiresAt: new Date(realNow().getTime() - 1000), nextAttemptAt: realNow() } });
    await processDue();
    expect(fakePush.to(tok)).toHaveLength(0);
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "SKIPPED", skipReason: "EXPIRED" });
  });

  it("collapses a burst of game-chat messages into one pending push", async () => {
    const { user } = await signedIn();
    const tok = await device(user.id, "a");
    clock.now = () => at(2); // held by quiet hours, so the burst piles up in one job
    for (const text of ["one", "two", "three"]) {
      notify({ userIds: [user.id], type: "GAME_MESSAGE", data: { gameId: "g1" }, params: { sport: { bn: "ফুটবল", en: "Football" }, venue: "Ground", actor: "Rafi", text }, collapseKey: "game:g1", inbox: false });
      await settle();
    }
    expect(await prisma.pushJob.count()).toBe(1);
    await processDue(at(8, 0, 1));
    expect(fakePush.to(tok)).toHaveLength(1);
    expect(fakePush.to(tok)[0]!.body).toBe("3 new messages");
  });
});

describe("inbox", () => {
  it("deletes one notification (mine only) or clears the lot", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    for (let i = 0; i < 3; i++) await prisma.notification.create({ data: { userId: a.user.id, type: "SYSTEM", data: {} } });
    const mine = (await get(a.auth, "/notifications")).body.data[0];
    expect(mine).toMatchObject({ category: "system", link: "/alerts" });
    expect((await del(b.auth, `/notifications/${mine.id}`)).status).toBe(404);
    expect((await del(a.auth, `/notifications/${mine.id}`)).body.data).toEqual({ deleted: 1 });
    expect((await del(a.auth, `/notifications/${mine.id}`)).status).toBe(404);
    expect((await del(a.auth, "/notifications")).body.data).toEqual({ deleted: 2 });
    expect((await get(a.auth, "/notifications")).body.data).toEqual([]);
  });
});

describe("trigger: someone near you is free today", () => {
  async function scene() {
    const free = await playerUser(w, "free@example.com", [{ sportId: w.football.id }]);
    const near = await playerUser(w, "near@example.com", [{ sportId: w.football.id }]);
    const otherSport = await playerUser(w, "cricket@example.com", [{ sportId: w.cricket.id }]);
    const far = await playerUser(w, "far@example.com", [{ sportId: w.football.id }], { districtId: w.dhaka.id, upazilaId: w.savar.id });
    const tokens = { near: await device(near.user.id, "near"), otherSport: await device(otherSport.user.id, "cr"), far: await device(far.user.id, "far"), free: await device(free.user.id, "free") };
    return { free, near, otherSport, far, tokens };
  }
  const goFree = (a: Auth, sportIds: number[]) => put(a, "/players/me/availability", { sportIds });

  it("tells neighbours who play that sport — not the person, not other sports, not other places — without their name", async () => {
    const { free, tokens } = await scene();
    expect((await goFree(free.auth, [w.football.id])).status).toBe(200);
    await settle();
    expect(fakePush.to(tokens.near)).toHaveLength(1);
    expect(fakePush.to(tokens.otherSport)).toHaveLength(0);
    expect(fakePush.to(tokens.far)).toHaveLength(0);
    expect(fakePush.to(tokens.free)).toHaveLength(0);
    const msg = fakePush.to(tokens.near)[0]!;
    expect(msg.title).toBe("Someone near you is free to play today");
    expect(JSON.stringify(fakePush.sent)).not.toMatch(/free@example|Player /);
    expect(fakePush.sent[0]!.message.data.link).toBe("/players?availableToday=true");
  });

  it("is debounced per player: toggling again within 6 hours doesn't re-announce", async () => {
    const { free } = await scene();
    await goFree(free.auth, [w.football.id]);
    await settle();
    await del(free.auth, "/players/me/availability");
    await goFree(free.auth, [w.football.id]);
    await settle();
    expect(await prisma.notification.count({ where: { type: "NEARBY_AVAILABLE" } })).toBe(1);
  });

  it("is capped per recipient per day", async () => {
    const near = await playerUser(w, "near@example.com", [{ sportId: w.football.id }]);
    const free = [];
    for (let i = 0; i < NEARBY_PER_DAY + 2; i++) free.push(await playerUser(w, `f${i}@example.com`, [{ sportId: w.football.id }]));
    for (const f of free) {
      await notifyNearbyAvailable(f.profileId, [w.football.id]);
      await settle();
    }
    expect(await prisma.notification.count({ where: { userId: near.user.id, type: "NEARBY_AVAILABLE" } })).toBe(NEARBY_PER_DAY);
  });

  it("honours the recipient's own switch, and reaches captains with an open game", async () => {
    const free = await playerUser(w, "free@example.com", [{ sportId: w.football.id }]);
    const quiet = await playerUser(w, "quiet@example.com", [{ sportId: w.football.id }]);
    const tq = await device(quiet.user.id, "q");
    await prisma.notificationPreference.create({ data: { userId: quiet.user.id, nearbyAvailable: false } });
    const rec = await recruiterUser(w);
    const tr = await device(rec.user.id, "rec");
    await makeRequest(w, rec.user.id, { districtId: w.patuakhali.id });
    await goFree(free.auth, [w.football.id]);
    await settle();
    expect(fakePush.to(tq)).toHaveLength(0);
    expect(await prisma.pushJob.count({ where: { userId: quiet.user.id, skipReason: "CATEGORY_OFF" } })).toBe(1);
    expect(fakePush.to(tr)).toHaveLength(1);
  });
});

describe("trigger: game reminders", () => {
  async function game(matchAt: Date) {
    const org = await playerUser(w, "org@example.com", [{ sportId: w.football.id }]);
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const pending = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const r = await makeRequest(w, org.user.id, { matchAt, playersNeeded: 4 });
    await makeApplication(r.id, a.user.id, "ACCEPTED");
    await makeApplication(r.id, pending.user.id, "PENDING");
    return { org, a, pending, r, tokens: { org: await device(org.user.id, "org"), a: await device(a.user.id, "a"), pending: await device(pending.user.id, "p") } };
  }

  it("2 hours before: the organiser and accepted players, once each — not people still waiting", async () => {
    const { tokens, r } = await game(new Date(realNow().getTime() + 100 * 60_000));
    expect(await sendGameReminders(realNow())).toBe(2);
    await settle();
    expect(fakePush.to(tokens.org)[0]!.title).toBe("Match starts in 2 hours");
    expect(fakePush.to(tokens.a)).toHaveLength(1);
    expect(fakePush.to(tokens.pending)).toHaveLength(0);
    expect(await sendGameReminders(realNow())).toBe(0); // already told
    expect((await prisma.notification.findFirstOrThrow({ where: { type: "GAME_REMINDER" } })).data).toMatchObject({ requestId: r.id, dedupe: `${r.id}:2h` });
  });

  it("the morning of: between 07:00 and 10:00 Dhaka, for a game later the same day", async () => {
    const morning = at(8);
    const { tokens } = await game(new Date(morning.getTime() + 8 * 3_600_000)); // 16:00
    expect(await sendGameReminders(at(6))).toBe(0); // too early
    expect(await sendGameReminders(morning)).toBe(2);
    await settle();
    expect(fakePush.to(tokens.org)[0]!.title).toBe("You have a match today");
    expect(await sendGameReminders(at(9))).toBe(0);
  });

  it("not for cancelled or hidden games, nor games further away", async () => {
    const org = await playerUser(w, "org@example.com", [{ sportId: w.football.id }]);
    await device(org.user.id, "o");
    const soon = new Date(realNow().getTime() + 100 * 60_000);
    await makeRequest(w, org.user.id, { matchAt: soon, status: "CANCELLED" });
    await makeRequest(w, org.user.id, { matchAt: soon, isHidden: true });
    await makeRequest(w, org.user.id, { matchAt: new Date(realNow().getTime() + 30 * 3_600_000) });
    expect(await sendGameReminders(realNow())).toBe(0);
  });
});

describe("trigger: game full / game chat", () => {
  it("tells people still waiting that the game is full (accept, open join and manual fill)", async () => {
    const org = await playerUser(w, "org@example.com", [{ sportId: w.football.id }]);
    const wait = await playerUser(w, "wait@example.com", [{ sportId: w.football.id }]);
    const win = await playerUser(w, "win@example.com", [{ sportId: w.football.id }]);
    const tw = await device(wait.user.id, "w");
    const r = await makeRequest(w, org.user.id, { playersNeeded: 1 });
    await makeApplication(r.id, wait.user.id, "PENDING");
    const app = await makeApplication(r.id, win.user.id, "PENDING");
    expect((await api().post(`${V1}/applications/${app.id}/accept`).set(org.auth)).status).toBe(200);
    await settle();
    expect(fakePush.to(tw).map((m) => m.title)).toContain("The match is full");
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: wait.user.id, type: "REQUEST_FILLED" } })).data).toMatchObject({ requestId: r.id });
  });

  it("pushes a game-chat message to everyone else in the game, never the sender, with no inbox row per message", async () => {
    const org = await playerUser(w, "org@example.com", [{ sportId: w.football.id }]);
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const r = await makeRequest(w, org.user.id, { playersNeeded: 3 });
    await makeApplication(r.id, a.user.id, "ACCEPTED");
    const to = await device(org.user.id, "o");
    const ta = await device(a.user.id, "a");
    expect((await api().post(`${V1}/games/${r.id}/chat/messages`).set(a.auth).send({ body: "on my way" })).status).toBe(201);
    await settle();
    expect(fakePush.to(to)).toHaveLength(1);
    expect(fakePush.to(to)[0]!.body).toContain("on my way");
    expect(fakePush.to(ta)).toHaveLength(0);
    expect(await prisma.notification.count({ where: { type: "GAME_MESSAGE" } })).toBe(0);
  });
});

describe("admin: announcements and the push log", () => {
  it("targets by role, sport and place, logs each recipient, and shows delivery numbers", async () => {
    const admin = await adminUser();
    const p1 = await playerUser(w, "p1@example.com", [{ sportId: w.football.id }]);
    const p2 = await playerUser(w, "p2@example.com", [{ sportId: w.football.id }]);
    const nodev = await playerUser(w, "nodev@example.com", [{ sportId: w.football.id }]);
    const off = await playerUser(w, "off@example.com", [{ sportId: w.football.id }]);
    const cricket = await playerUser(w, "cr@example.com", [{ sportId: w.cricket.id }]);
    const dhaka = await playerUser(w, "dh@example.com", [{ sportId: w.football.id }], { districtId: w.dhaka.id, upazilaId: w.savar.id });
    const t1 = await device(p1.user.id, "1");
    await device(p2.user.id, "2");
    await device(off.user.id, "off");
    await device(cricket.user.id, "cr");
    await device(dhaka.user.id, "dh");
    await prisma.notificationPreference.create({ data: { userId: off.user.id, system: false } });
    await prisma.webPushSubscription.create({ data: { userId: p2.user.id, endpoint: "https://push.example/p2", p256dh: "p".repeat(40), auth: "a".repeat(16) } });

    const q = { role: "PLAYER", sportId: w.football.id, districtId: w.patuakhali.id };
    expect((await get(admin.auth, "/admin/notifications/preview", q)).body.data.targetCount).toBe(4); // p1 p2 nodev off — not cricket, not Dhaka, not admin
    const sent = await api().post(`${V1}/admin/notifications/broadcast`).set(admin.auth).send({ title: "Ground closed Friday", body: "Kalapara ground is closed for repairs.", ...q });
    expect(sent.status).toBe(200);
    expect(sent.body.data.sentCount).toBe(4);
    await settle();

    expect(fakePush.to(t1)[0]).toMatchObject({ title: "Ground closed Friday", body: "Kalapara ground is closed for repairs." });
    expect(await prisma.notification.count({ where: { type: "ANNOUNCEMENT" } })).toBe(4); // the inbox keeps it for everyone, even with push off
    const list = (await get(admin.auth, "/admin/announcements")).body.data[0];
    expect(list).toMatchObject({ title: "Ground closed Friday", recipients: 4, delivery: { sent: 2, devicesReached: 3, failed: 0, skipped: { NO_DEVICE: 1, CATEGORY_OFF: 1 }, opened: 0 } });
    const inbox = (await get(p1.auth, "/notifications")).body.data[0];
    expect(inbox).toMatchObject({ type: "ANNOUNCEMENT", title: "Ground closed Friday", link: "/alerts" });
    await api().post(`${V1}/notifications/${inbox.id}/read`).set(p1.auth);
    expect((await get(admin.auth, "/admin/announcements")).body.data[0].delivery.opened).toBe(1);

    const log = (await get(admin.auth, "/admin/push-log", { status: "SKIPPED" })).body.data;
    expect(log.map((l: { skipReason: string }) => l.skipReason).sort()).toEqual(["CATEGORY_OFF", "NO_DEVICE"]);
    expect((await get(admin.auth, "/admin/push-stats")).body.data).toMatchObject({ last24h: { SENT: 2, SKIPPED: 2 }, backlog: 0 });
  });

  it("combines division and district filters instead of one overriding the other", async () => {
    const admin = await adminUser();
    await playerUser(w, "pat@example.com", [{ sportId: w.football.id }]);
    await playerUser(w, "dha@example.com", [{ sportId: w.football.id }], { districtId: w.dhaka.id, upazilaId: w.savar.id });
    const dist = await prisma.district.findUniqueOrThrow({ where: { id: w.patuakhali.id } });
    const both = await get(admin.auth, "/admin/notifications/preview", { divisionId: dist.divisionId, districtId: w.dhaka.id });
    expect(both.body.data.targetCount).toBe(0); // Dhaka district is not in Patuakhali's division
    expect((await get(admin.auth, "/admin/notifications/preview", { divisionId: dist.divisionId })).body.data.targetCount).toBe(1);
  });

  it("is for admins only", async () => {
    const p = await signedIn("p@example.com");
    for (const path of ["/admin/announcements", "/admin/push-log", "/admin/push-stats"]) expect((await get(p.auth, path)).status).toBe(403);
    expect((await api().post(`${V1}/admin/notifications/broadcast`).set(p.auth).send({ title: "hello", body: "world" })).status).toBe(403);
  });
});

describe("web push (standard VAPID)", () => {
  const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p".repeat(40), auth: "a".repeat(16) } });
  const subscribe = (a: Auth, n: string) => api().post(`${V1}/notifications/web-push/subscriptions`).set(a).send(sub(n));

  it("serves the public key, saves a subscription idempotently, and moves it to a new account", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    expect((await get(a.auth, "/notifications/web-push/key")).body.data.publicKey).toBeTruthy();
    expect((await subscribe(a.auth, "x")).status).toBe(200);
    expect((await subscribe(a.auth, "x")).status).toBe(200);
    expect(await prisma.webPushSubscription.count()).toBe(1);
    await subscribe(b.auth, "x");
    expect((await prisma.webPushSubscription.findFirstOrThrow()).userId).toBe(b.user.id);
    expect((await api().delete(`${V1}/notifications/web-push/subscriptions`).set(a.auth).send({ endpoint: sub("x").endpoint })).status).toBe(200);
    expect(await prisma.webPushSubscription.count()).toBe(1); // a can't remove b's
    await api().delete(`${V1}/notifications/web-push/subscriptions`).set(b.auth).send({ endpoint: sub("x").endpoint });
    expect(await prisma.webPushSubscription.count()).toBe(0);
  });

  it("validates, requires auth, caps at 10, and refuses when not configured", async () => {
    const a = await signedIn("a@example.com");
    expect((await api().post(`${V1}/notifications/web-push/subscriptions`).set(a.auth).send({ endpoint: "http://insecure.example/x", keys: sub("x").keys })).status).toBe(422);
    expect((await api().post(`${V1}/notifications/web-push/subscriptions`).set(a.auth).send({ endpoint: sub("x").endpoint, keys: { p256dh: "x", auth: "y" } })).status).toBe(422);
    expect((await api().post(`${V1}/notifications/web-push/subscriptions`).send(sub("x"))).status).toBe(401);
    expect((await api().post(`${V1}/notifications/devices`).set(a.auth).send({ token: "t".repeat(30), platform: "WEB" })).status).toBe(422); // FCM is for the apps
    for (let i = 0; i < 12; i++) await subscribe(a.auth, `d${i}`);
    expect(await prisma.webPushSubscription.count()).toBe(10);
    const { fakeWebPush } = await import("./fake-webpush.js");
    fakeWebPush.enabled = false;
    expect((await subscribe(a.auth, "z")).status).toBe(503);
  });

  it("pushes to the browser with the deep link in the user's language, and to the app, and removes expired subscriptions (404/410)", async () => {
    const { fakeWebPush } = await import("./fake-webpush.js");
    const a = await signedIn("a@example.com");
    const tok = await device(a.user.id, "phone"); // sets locale en
    await subscribe(a.auth, "live");
    await subscribe(a.auth, "dead");
    fakeWebPush.gone.add(sub("dead").endpoint);
    ping(a.user.id, "NEW_APPLICANT", { requestId: "req-7" });
    await settle();
    expect(fakeWebPush.to(sub("live").endpoint)).toEqual([expect.objectContaining({ title: "New applicant", link: "/en/request/req-7" })]);
    expect(fakePush.to(tok)).toHaveLength(1);
    expect(await prisma.webPushSubscription.findMany({ select: { endpoint: true } })).toEqual([{ endpoint: sub("live").endpoint }]);
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "SENT", deviceCount: 3, deliveredCount: 2 });
  });

  it("a browser-only user is reachable, honours quiet hours, and a failing endpoint is retried", async () => {
    const { fakeWebPush } = await import("./fake-webpush.js");
    const a = await signedIn("a@example.com");
    await subscribe(a.auth, "only");
    fakeWebPush.failing.add(sub("only").endpoint);
    ping(a.user.id);
    await settle();
    expect(await prisma.pushJob.findFirstOrThrow()).toMatchObject({ status: "PENDING", attempts: 1, lastError: "web push failed (500)" });
    fakeWebPush.failing.clear();
    await processDue(new Date(realNow().getTime() + backoffMs(1)));
    expect(fakeWebPush.to(sub("only").endpoint)).toHaveLength(1);
    clock.now = () => at(2);
    ping(a.user.id);
    await settle();
    expect(fakeWebPush.to(sub("only").endpoint)).toHaveLength(1); // held until 07:00
  });
});
