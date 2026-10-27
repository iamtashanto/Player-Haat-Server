import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "put" | "delete", path: string, a: Auth, body?: object, query: object = {}) => {
  const t = api()[method](`${V1}${path}`).set(a).query(query);
  return body === undefined ? t : t.send(body);
};

describe("shortlist", () => {
  it("saves, lists with the note, and removes — privately", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const saved = await call("put", `/shortlist/${p.profileId}`, rec.auth, { note: "Great first touch" });
    expect(saved.body.data).toMatchObject({ profileId: p.profileId, note: "Great first touch" });
    const list = (await call("get", "/shortlist", rec.auth)).body.data;
    expect(list).toEqual([expect.objectContaining({ note: "Great first touch", player: expect.objectContaining({ id: p.profileId, shortlisted: true }) })]);
    expect((await call("delete", `/shortlist/${p.profileId}`, rec.auth)).body.data.removed).toBe(true);
    expect((await call("delete", `/shortlist/${p.profileId}`, rec.auth)).body.data.removed).toBe(false); // idempotent
    expect((await call("get", "/shortlist", rec.auth)).body.data).toEqual([]);
    expect(await prisma.notification.count()).toBe(0); // the player is never told
  });

  it("saving again keeps the note unless a new one is sent", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com");
    await call("put", `/shortlist/${p.profileId}`, rec.auth, { note: "first" });
    expect((await call("put", `/shortlist/${p.profileId}`, rec.auth, {})).body.data.note).toBe("first");
    expect((await call("put", `/shortlist/${p.profileId}`, rec.auth, { note: "second" })).body.data.note).toBe("second");
    expect((await call("put", `/shortlist/${p.profileId}`, rec.auth, { note: null })).body.data.note).toBeNull();
    expect(await prisma.shortlistEntry.count()).toBe(1);
  });

  it("marks saved players in search results and on their profile", async () => {
    const rec = await recruiterUser(w);
    const saved = await playerUser(w, "saved@example.com", [{ sportId: w.football.id }]);
    const other = await playerUser(w, "other@example.com", [{ sportId: w.football.id }]);
    await call("put", `/shortlist/${saved.profileId}`, rec.auth, {});
    const cards = (await call("get", "/players", rec.auth, undefined, { sportId: w.football.id })).body.data;
    expect(Object.fromEntries(cards.map((c: { id: string; shortlisted: boolean }) => [c.id, c.shortlisted]))).toEqual({ [saved.profileId]: true, [other.profileId]: false });
    expect((await call("get", `/players/${saved.profileId}`, rec.auth)).body.data.shortlisted).toBe(true);
    // another recruiter's list is their own
    const rec2 = await recruiterUser(w, "rec2@example.com");
    expect((await call("get", `/players/${saved.profileId}`, rec2.auth)).body.data.shortlisted).toBe(false);
    expect((await call("get", "/shortlist", rec2.auth)).body.data).toEqual([]);
  });

  it("drops players who stop being visible, and brings them back", async () => {
    const rec = await recruiterUser(w);
    const p = await playerUser(w, "p@example.com");
    await call("put", `/shortlist/${p.profileId}`, rec.auth, {});
    await prisma.playerProfile.update({ where: { id: p.profileId }, data: { hiddenByAdminAt: new Date() } });
    expect((await call("get", "/shortlist", rec.auth)).body.data).toEqual([]);
    await prisma.playerProfile.update({ where: { id: p.profileId }, data: { hiddenByAdminAt: null } });
    expect((await call("get", "/shortlist", rec.auth)).body.data).toHaveLength(1);
  });

  it("filters by sport and paginates newest first", async () => {
    const rec = await recruiterUser(w);
    const fb = await playerUser(w, "fb@example.com", [{ sportId: w.football.id }]);
    const cr = await playerUser(w, "cr@example.com", [{ sportId: w.cricket.id }]);
    const fb2 = await playerUser(w, "fb2@example.com", [{ sportId: w.football.id }]);
    for (const p of [fb, cr, fb2]) await call("put", `/shortlist/${p.profileId}`, rec.auth, {});
    expect((await call("get", "/shortlist", rec.auth, undefined, { sportId: w.football.id })).body.data).toHaveLength(2);
    const page1 = await call("get", "/shortlist", rec.auth, undefined, { limit: 2 });
    expect(page1.body.data.map((x: { player: { id: string } }) => x.player.id)).toEqual([fb2.profileId, cr.profileId]);
    const page2 = await call("get", "/shortlist", rec.auth, undefined, { limit: 2, cursor: page1.body.meta.nextCursor });
    expect(page2.body.data.map((x: { player: { id: string } }) => x.player.id)).toEqual([fb.profileId]);
  });

  it("is for onboarded recruiters only, and refuses players that don't exist", async () => {
    const rec = await recruiterUser(w);
    const player = await playerUser(w, "p@example.com");
    expect((await call("put", `/shortlist/${player.profileId}`, player.auth, {})).status).toBe(403);
    expect((await call("get", "/shortlist", player.auth)).status).toBe(403);
    const fresh = await recruiterUser(w, "fresh@example.com", { onboard: false });
    expect((await call("get", "/shortlist", fresh.auth)).body.error.code).toBe("RECRUITER_PROFILE_REQUIRED");
    expect((await call("put", "/shortlist/nope", rec.auth, {})).status).toBe(404);
    expect((await call("put", `/shortlist/${player.profileId}`, rec.auth, { note: "x".repeat(301) })).status).toBe(422);
  });
});
