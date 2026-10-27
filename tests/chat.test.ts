import { beforeEach, describe, expect, it } from "vitest";
import { V1, acceptedInvite, adminUser, api, notificationsOf, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post", path: string, a: Auth, body: object = {}, query: object = {}) => api()[method](`${V1}${path}`).set(a).query(query).send(body);
const open = (a: Auth, body: object) => call("post", "/conversations", a, body);
const say = (a: Auth, id: string, body: string) => call("post", `/conversations/${id}/messages`, a, { body });

async function setup() {
  const player = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
  const rec = await recruiterUser(w);
  const conv = (await open(rec.auth, { profileId: player.profileId })).body.data as { id: string };
  return { player, rec, id: conv.id };
}

describe("starting a conversation", () => {
  it("a recruiter can write to a player who shows their number on tap", async () => {
    const player = await playerUser(w, "p@example.com");
    const rec = await recruiterUser(w);
    const res = await open(rec.auth, { profileId: player.profileId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ other: { role: "PLAYER", profileId: player.profileId }, unread: 0, blockedByMe: false });
    expect((await open(rec.auth, { profileId: player.profileId })).body.data.id).toBe(res.body.data.id); // same pair, same thread
  });

  it("follows the player's choice: 'after I accept' keeps strangers out until an accepted invite", async () => {
    const player = await playerUser(w, "p@example.com");
    const rec = await recruiterUser(w);
    await prisma.playerProfile.update({ where: { id: player.profileId }, data: { contactVisibility: "AFTER_ACCEPT" } });
    const denied = await open(rec.auth, { profileId: player.profileId });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("CHAT_UNAVAILABLE");
    await acceptedInvite(rec.user.id, player.profileId);
    expect((await open(rec.auth, { profileId: player.profileId })).status).toBe(200);
  });

  it("a player opens a conversation only with a recruiter they've accepted each other with", async () => {
    const player = await playerUser(w, "p@example.com");
    const rec = await recruiterUser(w);
    expect((await open(player.auth, { recruiterId: rec.recruiterId })).status).toBe(403);
    await acceptedInvite(rec.user.id, player.profileId);
    expect((await open(player.auth, { recruiterId: rec.recruiterId })).status).toBe(200);
  });

  it("validates who it's for, and recruiters finish onboarding first", async () => {
    const player = await playerUser(w, "p@example.com");
    const rec = await recruiterUser(w);
    expect((await open(rec.auth, {})).status).toBe(422);
    expect((await open(rec.auth, { profileId: player.profileId, recruiterId: "x" })).status).toBe(422);
    expect((await open(rec.auth, { profileId: "nope" })).status).toBe(404);
    expect((await open(player.auth, { profileId: player.profileId })).status).toBe(422); // a player names a recruiter, not a player
    const fresh = await recruiterUser(w, "fresh@example.com", { onboard: false });
    expect((await open(fresh.auth, { profileId: player.profileId })).body.error.code).toBe("RECRUITER_PROFILE_REQUIRED");
    await prisma.user.update({ where: { id: player.user.id }, data: { status: "SUSPENDED" } });
    expect((await open(rec.auth, { profileId: player.profileId })).status).toBe(404);
  });

  it("caps how many new conversations a recruiter starts per day", async () => {
    const rec = await recruiterUser(w);
    const target = await playerUser(w, "target@example.com");
    const many = [];
    for (let i = 0; i < 30; i++) many.push((await playerUser(w, `m${i}@example.com`)).user.id);
    await prisma.conversation.createMany({ data: many.map((playerId) => ({ recruiterId: rec.user.id, playerId })) });
    const res = await open(rec.auth, { profileId: target.profileId });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("CHAT_LIMIT");
  });
});

describe("messages", () => {
  it("both sides send and read; unread counts and previews follow along", async () => {
    const { player, rec, id } = await setup();
    await say(rec.auth, id, "Hi! Can you make it Friday?");
    await say(rec.auth, id, "We play at 4pm");
    let list = (await call("get", "/conversations", player.auth)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ unread: 2, lastMessagePreview: "We play at 4pm", other: { role: "RECRUITER", organization: "Barishal United" } });
    expect((await call("get", "/conversations", rec.auth)).body.data[0].unread).toBe(0); // your own messages aren't unread to you

    const msgs = (await call("get", `/conversations/${id}/messages`, player.auth)).body.data;
    expect(msgs.map((m: { body: string; mine: boolean }) => [m.body, m.mine])).toEqual([["We play at 4pm", false], ["Hi! Can you make it Friday?", false]]); // newest first
    expect((await call("post", `/conversations/${id}/read`, player.auth)).body.data.unread).toBe(0);
    await say(player.auth, id, "Yes, see you there");
    list = (await call("get", "/conversations", player.auth)).body.data;
    expect(list[0]).toMatchObject({ unread: 0, lastMessagePreview: "Yes, see you there" });
    expect((await call("get", "/conversations", rec.auth)).body.data[0].unread).toBe(1);
  });

  it("push goes out once when a thread gets unread messages, not per message", async () => {
    const { player, rec, id } = await setup();
    await say(rec.auth, id, "one");
    await say(rec.auth, id, "two");
    await say(rec.auth, id, "three");
    const pushes = await notificationsOf(player.user.id, "NEW_MESSAGE");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data).toMatchObject({ conversationId: id, text: "one" });
    await call("post", `/conversations/${id}/read`, player.auth);
    await say(rec.auth, id, "four");
    expect(await notificationsOf(player.user.id, "NEW_MESSAGE")).toHaveLength(2);
  });

  it("an open chat polls for what's new, in order, and scrolls back through older messages", async () => {
    const { player, rec, id } = await setup();
    const sent: string[] = [];
    for (let i = 1; i <= 5; i++) sent.push((await say(rec.auth, id, `m${i}`)).body.data.id);
    const fresh = await call("get", `/conversations/${id}/messages`, player.auth, {}, { after: sent[2] });
    expect(fresh.body.data.map((m: { body: string }) => m.body)).toEqual(["m4", "m5"]);
    expect((await call("get", `/conversations/${id}/messages`, player.auth, {}, { after: sent[4] })).body.data).toEqual([]);
    const page1 = await call("get", `/conversations/${id}/messages`, player.auth, {}, { limit: 2 });
    expect(page1.body.data.map((m: { body: string }) => m.body)).toEqual(["m5", "m4"]);
    const page2 = await call("get", `/conversations/${id}/messages`, player.auth, {}, { limit: 2, before: page1.body.data[1].id });
    expect(page2.body.data.map((m: { body: string }) => m.body)).toEqual(["m3", "m2"]);
    expect((await call("get", `/conversations/${id}/messages`, player.auth, {}, { after: "nope" })).status).toBe(422);
  });

  it("rejects empty and over-long messages", async () => {
    const { rec, id } = await setup();
    for (const body of ["", "   ", "x".repeat(2001)]) expect((await say(rec.auth, id, body)).status).toBe(422);
    expect((await say(rec.auth, id, "x".repeat(2000))).status).toBe(201);
    expect((await say(rec.auth, id, "  trimmed  ")).body.data.body).toBe("trimmed");
  });

  it("outsiders can't see, read or write in someone else's conversation", async () => {
    const { id } = await setup();
    const outsider = await playerUser(w, "outsider@example.com");
    const otherRec = await recruiterUser(w, "otherrec@example.com");
    for (const who of [outsider, otherRec]) {
      expect((await call("get", `/conversations/${id}/messages`, who.auth)).status).toBe(404);
      expect((await say(who.auth, id, "hello")).status).toBe(404);
      expect((await call("post", `/conversations/${id}/read`, who.auth)).status).toBe(404);
      expect((await call("get", "/conversations", who.auth)).body.data).toEqual([]);
    }
    expect((await api().get(`${V1}/conversations`)).status).toBe(401);
  });
});

describe("control", () => {
  it("a player can block a recruiter and unblock them; the recruiter just can't write", async () => {
    const { player, rec, id } = await setup();
    await say(rec.auth, id, "hello");
    const blocked = await call("post", `/conversations/${id}/block`, player.auth);
    expect(blocked.body.data.blockedByMe).toBe(true);
    const denied = await say(rec.auth, id, "please reply");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("CHAT_UNAVAILABLE"); // no hint that they were blocked
    expect((await call("get", "/conversations", rec.auth)).body.data).toEqual([]);
    expect((await open(rec.auth, { profileId: player.profileId })).status).toBe(403);
    expect((await call("get", "/conversations", player.auth)).body.data).toHaveLength(1); // the player still has it
    expect((await call("post", `/conversations/${id}/unblock`, player.auth)).body.data.blockedByMe).toBe(false);
    expect((await say(rec.auth, id, "thanks")).status).toBe(201);
  });

  it("only the player can block", async () => {
    const { rec, id } = await setup();
    expect((await call("post", `/conversations/${id}/block`, rec.auth)).status).toBe(403);
  });

  it("people who get suspended drop out of the list and can't be messaged", async () => {
    const { player, rec, id } = await setup();
    await prisma.user.update({ where: { id: player.user.id }, data: { status: "SUSPENDED" } });
    expect((await call("get", "/conversations", rec.auth)).body.data).toEqual([]);
    expect((await say(rec.auth, id, "hello?")).status).toBe(403);
  });
});

describe("moderation", () => {
  it("a participant can report a conversation; an admin reads it, and every read is audit-logged", async () => {
    const { player, rec, id } = await setup();
    await say(rec.auth, id, "send me money first");
    await say(player.auth, id, "no");
    const report = await call("post", "/reports", player.auth, { targetType: "CONVERSATION", targetId: id, reason: "SCAM_OR_PAYMENT" });
    expect(report.status).toBe(201);

    const admin = await adminUser();
    const t = (await call("get", `/admin/conversations/${id}/transcript`, admin.auth)).body.data;
    expect(t.messages.map((m: { from: string; body: string }) => [m.from, m.body])).toEqual([["RECRUITER", "send me money first"], ["PLAYER", "no"]]);
    expect(await prisma.adminAction.count({ where: { action: "CONVERSATION_VIEW", targetId: id, adminId: admin.user.id } })).toBe(1);
    expect((await call("get", "/admin/conversations/nope/transcript", admin.auth)).status).toBe(404);
  });

  it("outsiders can't report a conversation they aren't in", async () => {
    const { id } = await setup();
    const outsider = await playerUser(w, "outsider@example.com");
    expect((await call("post", "/reports", outsider.auth, { targetType: "CONVERSATION", targetId: id, reason: "SPAM" })).status).toBe(404);
  });
});
