import { beforeEach, describe, expect, it } from "vitest";
import { V1, acceptedInvite, api, giveCredits, makeApplication, makeRequest, notificationsOf, playerUser, prisma, recruiterUser, registerAs, resetDb, seedWorld, setPricing, withPhone, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "patch", path: string, a: Auth, body: object = {}) => api()[method](`${V1}${path}`).set(a).send(body);
const tap = (a: Auth, profileId: string) => call("post", `/players/${profileId}/contact`, a);
const balanceOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance;

async function setup() {
  const player = await playerUser(w, "player@example.com", [{ sportId: w.football.id }]);
  await withPhone(player.user.id, "+8801712345678");
  const rec = await recruiterUser(w);
  return { player, rec };
}

describe("tap to show a number (the default)", () => {
  it("one tap shows it — no approval, no cost — and the player is told who looked", async () => {
    const { player, rec } = await setup();
    const res = await tap(rec.auth, player.profileId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone: "+8801712345678", cost: 0 });

    const [n] = await notificationsOf(player.user.id, "CONTACT_VIEWED");
    expect(n!.data).toMatchObject({ profileId: player.profileId, recruiterId: rec.recruiterId });
    expect(String((n!.data as { actor: string }).actor)).toContain("Barishal United");
  });

  it("opening the same number again is free and doesn't notify twice", async () => {
    const { player, rec } = await setup();
    await tap(rec.auth, player.profileId);
    await tap(rec.auth, player.profileId);
    expect(await prisma.contactReveal.count()).toBe(1);
    expect(await notificationsOf(player.user.id, "CONTACT_VIEWED")).toHaveLength(1);
  });

  it("the player sees who looked, newest first, with enough to decide whether to reply", async () => {
    const { player, rec } = await setup();
    const rec2 = await recruiterUser(w, "second@example.com", { organization: "Dhaka Abahani" });
    await tap(rec.auth, player.profileId);
    await tap(rec2.auth, player.profileId);
    const views = (await call("get", "/players/me/contact-views", player.auth)).body.data;
    expect(views.map((v: { viewer: { organization: string } }) => v.viewer.organization)).toEqual(["Dhaka Abahani", "Barishal United"]);
    expect(views[0].viewer).toMatchObject({ role: "RECRUITER", recruiterId: rec2.recruiterId, verified: false });
    expect(JSON.stringify(views)).not.toMatch(/@example\.com|phone/); // who looked, never their contact details
  });

  it("players can look too (captains use it), but only the player behind it sees the view list", async () => {
    const { player } = await setup();
    const other = await playerUser(w, "other@example.com");
    expect((await tap(other.auth, player.profileId)).body.data.phone).toBe("+8801712345678");
    expect((await call("get", "/players/me/contact-views", other.auth)).body.data).toEqual([]);
  });

  it("answers 404 for players nobody can reach, 409 when there's no number, and needs recruiter onboarding", async () => {
    const { player, rec } = await setup();
    const hidden = await playerUser(w, "hidden@example.com");
    await withPhone(hidden.user.id, "+8801811111111");
    await prisma.playerProfile.update({ where: { id: hidden.profileId }, data: { hiddenByAdminAt: new Date() } });
    expect((await tap(rec.auth, hidden.profileId)).status).toBe(404);
    const suspended = await playerUser(w, "susp@example.com");
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: "SUSPENDED" } });
    expect((await tap(rec.auth, suspended.profileId)).status).toBe(404);
    const noPhone = await playerUser(w, "nophone@example.com");
    const res = await tap(rec.auth, noPhone.profileId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PLAYER_NO_PHONE");
    const fresh = await recruiterUser(w, "fresh@example.com", { onboard: false });
    expect((await tap(fresh.auth, player.profileId)).body.error.code).toBe("RECRUITER_PROFILE_REQUIRED");
    expect((await api().post(`${V1}/players/${player.profileId}/contact`)).status).toBe(401);
  });
});

describe("the player controls who can see their number", () => {
  it("'after I accept' locks it, and an accepted invite unlocks it for free", async () => {
    const { player, rec } = await setup();
    const set = await call("patch", "/players/me", player.auth, { contactVisibility: "AFTER_ACCEPT" });
    expect(set.body.data.contactVisibility).toBe("AFTER_ACCEPT");

    const locked = await tap(rec.auth, player.profileId);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe("CONTACT_LOCKED");
    expect(JSON.stringify(locked.body)).not.toContain("8801712345678");
    expect((await call("get", `/players/${player.profileId}/contact`, rec.auth)).body.data).toMatchObject({ state: "LOCKED", visibility: "AFTER_ACCEPT", alreadyRevealed: false });

    await acceptedInvite(rec.user.id, player.profileId);
    const open = await tap(rec.auth, player.profileId);
    expect(open.body.data).toMatchObject({ phone: "+8801712345678", cost: 0 });
  });

  it("accepting an application also counts as acceptance", async () => {
    const { player } = await setup();
    await call("patch", "/players/me", player.auth, { contactVisibility: "AFTER_ACCEPT" });
    const captain = await recruiterUser(w, "captain@example.com");
    const req = await makeRequest(w, captain.user.id);
    await makeApplication(req.id, player.user.id, "ACCEPTED");
    expect((await tap(captain.auth, player.profileId)).status).toBe(200);
    const stranger = await recruiterUser(w, "stranger@example.com");
    expect((await tap(stranger.auth, player.profileId)).status).toBe(403);
  });

  it("a new setting applies at once, even to someone who looked before", async () => {
    const { player, rec } = await setup();
    await tap(rec.auth, player.profileId);
    await call("patch", "/players/me", player.auth, { contactVisibility: "AFTER_ACCEPT" });
    expect((await tap(rec.auth, player.profileId)).status).toBe(403);
    await call("patch", "/players/me", player.auth, { contactVisibility: "ON_TAP" });
    expect((await tap(rec.auth, player.profileId)).status).toBe(200);
  });

  it("rejects values that aren't a choice, and recruiters can't change a player's setting", async () => {
    const { player, rec } = await setup();
    expect((await call("patch", "/players/me", player.auth, { contactVisibility: "NEVER" })).status).toBe(422);
    expect((await call("patch", "/players/me", rec.auth, { contactVisibility: "ON_TAP" })).status).toBe(403);
    expect((await call("get", "/players/me", player.auth)).body.data.contactVisibility).toBe("ON_TAP");
  });
});

describe("pay-per-contact (switched on by the admin)", () => {
  async function paid(free = 2, cost = 3) {
    await setPricing({ contact_credits_enabled: true, contact_free_per_day: free, contact_credit_cost: cost });
  }

  it("is entirely free while monetisation is off, however many numbers someone opens", async () => {
    const { rec } = await setup();
    await setPricing({ contact_free_per_day: 0, contact_credit_cost: 5 }); // prices set, but the switch is off
    for (let i = 0; i < 6; i++) {
      const p = await playerUser(w, `p${i}@example.com`);
      await withPhone(p.user.id, `+88017000000${i}0`);
      expect((await tap(rec.auth, p.profileId)).body.data.cost).toBe(0);
    }
  });

  it("gives a free daily allowance, then charges credits and records the spend", async () => {
    await paid(2, 3);
    const { rec } = await setup();
    await giveCredits(rec.user.id, 4);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await playerUser(w, `p${i}@example.com`);
      await withPhone(p.user.id, `+88017000000${i}1`);
      ids.push(p.profileId);
    }
    expect((await tap(rec.auth, ids[0]!)).body.data.cost).toBe(0);
    expect((await tap(rec.auth, ids[1]!)).body.data.cost).toBe(0);

    const quote = (await call("get", `/players/${ids[2]}/contact`, rec.auth)).body.data;
    expect(quote).toMatchObject({ state: "OPEN", cost: 3, freeLeftToday: 0, balance: 4, alreadyRevealed: false });

    const third = await tap(rec.auth, ids[2]!);
    expect(third.body.data).toMatchObject({ cost: 3, balance: 1 });
    const broke = await tap(rec.auth, ids[3]!);
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe("CREDITS_REQUIRED");
    expect(await prisma.contactReveal.count({ where: { profileId: ids[3] } })).toBe(0); // no number, no row, no charge
    expect(await balanceOf(rec.user.id)).toBe(1);
    expect((await prisma.creditTransaction.findMany({ where: { userId: rec.user.id, reason: "CONTACT_REVEAL" } }))).toEqual([expect.objectContaining({ delta: -3, refId: ids[2] })]);

    expect((await tap(rec.auth, ids[2]!)).body.data.cost).toBe(0); // already opened: free forever
  });

  it("two simultaneous first taps charge once", async () => {
    await paid(0, 2);
    const { player, rec } = await setup();
    await giveCredits(rec.user.id, 10);
    const results = await Promise.all([tap(rec.auth, player.profileId), tap(rec.auth, player.profileId)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await balanceOf(rec.user.id)).toBe(8);
    expect(await prisma.contactReveal.count()).toBe(1);
  });

  it("people the player has accepted are never charged", async () => {
    await paid(0, 5);
    const { player, rec } = await setup();
    await acceptedInvite(rec.user.id, player.profileId);
    expect((await tap(rec.auth, player.profileId)).body.data).toMatchObject({ cost: 0 });
    expect((await call("get", `/players/${player.profileId}/contact`, rec.auth)).body.data).toMatchObject({ state: "RELATED", cost: 0 });
  });

  it("tells the player nothing about money — they're the one being looked at", async () => {
    await paid(0, 5);
    const { player, rec } = await setup();
    await giveCredits(rec.user.id, 5);
    await tap(rec.auth, player.profileId);
    expect(JSON.stringify((await call("get", "/players/me/contact-views", player.auth)).body)).not.toMatch(/cost|credit|balance/i);
    void registerAs;
  });
});
