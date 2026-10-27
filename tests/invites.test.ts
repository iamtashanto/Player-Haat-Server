import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeRequest, notificationsOf, playerUser, prisma, recruiterUser, resetDb, seedWorld, withPhone, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post", path: string, a: Auth, body: object = {}, query: object = {}) => api()[method](`${V1}${path}`).set(a).query(query).send(body);
const invite = (a: Auth, profileId: string, extra: object = {}) => call("post", "/invites", a, { profileId, ...extra });

async function setup() {
  const player = await playerUser(w, "player@example.com", [{ sportId: w.football.id, positions: ["ST"] }]);
  await withPhone(player.user.id, "+8801712345678");
  const rec = await recruiterUser(w);
  await withPhone(rec.user.id, "+8801899999999");
  return { player, rec };
}

describe("sending", () => {
  it("invites a player, notifies them, and shows the recruiter in the player's inbox", async () => {
    const { player, rec } = await setup();
    const res = await invite(rec.auth, player.profileId, { sportId: w.football.id, message: "Come to our trial" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "PENDING", message: "Come to our trial", sport: { code: "FOOTBALL" }, player: { profileId: player.profileId } });
    expect(res.body.data.contact).toBeUndefined(); // no numbers before a yes

    const [n] = await notificationsOf(player.user.id, "INVITE_RECEIVED");
    expect(n!.data).toMatchObject({ inviteId: res.body.data.id });

    const inbox = (await call("get", "/invites/received", player.auth)).body.data;
    expect(inbox).toEqual([expect.objectContaining({ status: "PENDING", recruiter: expect.objectContaining({ recruiterId: rec.recruiterId, organization: "Barishal United" }) })]);
    expect(JSON.stringify(inbox)).not.toContain("8801899999999");
  });

  it("can be tied to the recruiter's own event, which supplies the sport", async () => {
    const { player, rec } = await setup();
    const event = await makeRequest(w, rec.user.id, { sportId: w.football.id });
    const res = await invite(rec.auth, player.profileId, { requestId: event.id });
    expect(res.body.data).toMatchObject({ sport: { code: "FOOTBALL" }, request: { id: event.id } });
    const other = await recruiterUser(w, "other@example.com");
    expect((await invite(other.auth, (await playerUser(w, "q@example.com", [{ sportId: w.football.id }])).profileId, { requestId: event.id })).status).toBe(422); // not their event
  });

  it("refuses: unknown or hidden players, a sport they don't have, and non-recruiters", async () => {
    const { player, rec } = await setup();
    expect((await invite(rec.auth, "nope")).status).toBe(404);
    await prisma.playerProfile.update({ where: { id: player.profileId }, data: { isVisible: false } });
    expect((await invite(rec.auth, player.profileId)).status).toBe(404);
    await prisma.playerProfile.update({ where: { id: player.profileId }, data: { isVisible: true } });
    expect((await invite(rec.auth, player.profileId, { sportId: w.cricket.id })).status).toBe(422);
    expect((await invite(player.auth, player.profileId)).status).toBe(403);
    const fresh = await recruiterUser(w, "fresh@example.com", { onboard: false });
    expect((await invite(fresh.auth, player.profileId)).body.error.code).toBe("RECRUITER_PROFILE_REQUIRED");
    expect((await invite(rec.auth, player.profileId, { message: "" })).status).toBe(422);
  });

  it("allows one open invitation per player, and waits a week after a decline", async () => {
    const { player, rec } = await setup();
    const first = await invite(rec.auth, player.profileId);
    const dup = await invite(rec.auth, player.profileId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("INVITE_ALREADY_PENDING");
    expect((await invite(rec.auth, player.profileId)).status).toBe(409);

    await call("post", `/invites/${first.body.data.id}/decline`, player.auth);
    const soon = await invite(rec.auth, player.profileId);
    expect(soon.status).toBe(409);
    expect(soon.body.error.code).toBe("INVITE_COOLDOWN");
    await prisma.invite.updateMany({ data: { respondedAt: hoursFromNow(-24 * 8) } });
    expect((await invite(rec.auth, player.profileId)).status).toBe(201);
  });

  it("caps invitations per day", async () => {
    const { player, rec } = await setup();
    const others = [];
    for (let i = 0; i < 30; i++) others.push((await playerUser(w, `o${i}@example.com`)).profileId);
    await prisma.invite.createMany({ data: others.map((profileId) => ({ recruiterId: rec.user.id, profileId, status: "DECLINED" as const, respondedAt: hoursFromNow(-1000) })) });
    const res = await invite(rec.auth, player.profileId);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("INVITE_LIMIT");
  });
});

describe("answering", () => {
  it("accepting shares both numbers, notifies the recruiter and opens chat", async () => {
    const { player, rec } = await setup();
    const id = (await invite(rec.auth, player.profileId)).body.data.id;
    const res = await call("post", `/invites/${id}/accept`, player.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "ACCEPTED", contact: { phone: "+8801899999999" } }); // the player now sees the recruiter's number
    expect((await call("get", "/invites/sent", rec.auth)).body.data[0]).toMatchObject({ status: "ACCEPTED", contact: { phone: "+8801712345678" } }); // …and the recruiter sees the player's
    expect(await notificationsOf(rec.user.id, "INVITE_ACCEPTED")).toHaveLength(1);

    // an acceptance is consent: it overrides "after I accept" and chat opens
    await call("post", "/conversations", rec.auth, { profileId: player.profileId });
    expect((await call("post", "/conversations", player.auth, { recruiterId: rec.recruiterId })).status).toBe(200);
  });

  it("declining notifies the recruiter, shares nothing, and can't be undone or repeated", async () => {
    const { player, rec } = await setup();
    const id = (await invite(rec.auth, player.profileId)).body.data.id;
    const res = await call("post", `/invites/${id}/decline`, player.auth);
    expect(res.body.data.status).toBe("DECLINED");
    expect(res.body.data.contact).toBeUndefined();
    expect(await notificationsOf(rec.user.id, "INVITE_DECLINED")).toHaveLength(1);
    expect((await call("post", `/invites/${id}/accept`, player.auth)).status).toBe(409);
    expect((await call("post", `/invites/${id}/decline`, player.auth)).status).toBe(409);
  });

  it("only the invited player can answer, only the recruiter can withdraw", async () => {
    const { player, rec } = await setup();
    const other = await playerUser(w, "other@example.com");
    const otherRec = await recruiterUser(w, "otherrec@example.com");
    const id = (await invite(rec.auth, player.profileId)).body.data.id;
    expect((await call("post", `/invites/${id}/accept`, other.auth)).status).toBe(404);
    expect((await call("post", `/invites/${id}/accept`, rec.auth)).status).toBe(403);
    expect((await call("post", `/invites/${id}/withdraw`, otherRec.auth)).status).toBe(404);
    expect((await call("post", `/invites/${id}/withdraw`, player.auth)).status).toBe(403);
    expect((await call("post", `/invites/${id}/withdraw`, rec.auth)).body.data.status).toBe("WITHDRAWN");
    expect((await call("post", `/invites/${id}/accept`, player.auth)).status).toBe(409);
  });

  it("two simultaneous answers settle on one", async () => {
    const { player, rec } = await setup();
    const id = (await invite(rec.auth, player.profileId)).body.data.id;
    const results = await Promise.all([call("post", `/invites/${id}/accept`, player.auth), call("post", `/invites/${id}/decline`, player.auth)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await notificationsOf(rec.user.id)).toHaveLength(1);
  });

  it("lists filter by status, and each role sees only its own", async () => {
    const { player, rec } = await setup();
    const a = await playerUser(w, "a@example.com", [{ sportId: w.football.id }]);
    const id1 = (await invite(rec.auth, player.profileId)).body.data.id;
    await invite(rec.auth, a.profileId);
    await call("post", `/invites/${id1}/accept`, player.auth);
    expect((await call("get", "/invites/sent", rec.auth)).body.data).toHaveLength(2);
    expect((await call("get", "/invites/sent", rec.auth, {}, { status: "PENDING" })).body.data).toHaveLength(1);
    expect((await call("get", "/invites/received", a.auth)).body.data).toHaveLength(1);
    expect((await call("get", "/invites/sent", player.auth)).status).toBe(403);
    expect((await call("get", "/invites/received", rec.auth)).status).toBe(403);
  });
});
