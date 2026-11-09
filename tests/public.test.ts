import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeRequest, playerUser, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

describe("public (signed-out) reads", () => {
  it("serves a visible player's profile and search results without sign-in, with no contact details", async () => {
    const p = await playerUser(w, "pub@example.com", [{ sportId: w.football.id }]);
    const one = await api().get(`${V1}/public/players/${p.profileId}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: p.profileId, shortlisted: false });
    expect(JSON.stringify(one.body.data)).not.toMatch(/phone|email/i);

    const list = await api().get(`${V1}/public/players`).query({ sportId: w.football.id });
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([p.profileId]);
    expect(list.body.meta).toHaveProperty("nextCursor");
  });

  it("hides hidden players and unknown ids", async () => {
    const p = await playerUser(w, "hid@example.com", [{ sportId: w.football.id }]);
    await prisma.playerProfile.update({ where: { id: p.profileId }, data: { isVisible: false } });
    expect((await api().get(`${V1}/public/players/${p.profileId}`)).status).toBe(404);
    expect((await api().get(`${V1}/public/players/nope`)).status).toBe(404);
    expect((await api().get(`${V1}/public/players`).query({ sportId: w.football.id })).body.data).toEqual([]);
  });

  it("serves requests signed out, but keeps the private endpoints private", async () => {
    expect((await api().get(`${V1}/public/requests`)).status).toBe(200);
    expect((await api().get(`${V1}/public/requests/missing`)).status).toBe(404);
    expect((await api().get(`${V1}/requests`)).status).toBe(401);
    expect((await api().get(`${V1}/players`)).status).toBe(401);
  });

  it("hides admin-hidden, suspended and deleted players (profile and search)", async () => {
    const adminHidden = await playerUser(w, "ah@example.com", [{ sportId: w.football.id }]);
    const suspended = await playerUser(w, "su@example.com", [{ sportId: w.football.id }]);
    const deleted = await playerUser(w, "de@example.com", [{ sportId: w.football.id }]);
    const shown = await playerUser(w, "ok@example.com", [{ sportId: w.football.id }]);
    await prisma.playerProfile.update({ where: { id: adminHidden.profileId }, data: { hiddenByAdminAt: new Date() } });
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: "SUSPENDED" } });
    await prisma.user.update({ where: { id: deleted.user.id }, data: { status: "DELETED" } });

    for (const p of [adminHidden, suspended, deleted]) expect((await api().get(`${V1}/public/players/${p.profileId}`)).status).toBe(404);
    expect((await api().get(`${V1}/public/players/${shown.profileId}`)).status).toBe(200);
    const list = await api().get(`${V1}/public/players`).query({ sportId: w.football.id });
    expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([shown.profileId]);
  });

  it("drops a hidden sport from a public profile and from sport searches", async () => {
    const p = await playerUser(w, "hs@example.com", [{ sportId: w.football.id }, { sportId: w.cricket.id }]);
    await prisma.playerSport.updateMany({ where: { profileId: p.profileId, sportId: w.cricket.id }, data: { isVisible: false } });
    const one = await api().get(`${V1}/public/players/${p.profileId}`);
    expect(one.body.data.sports.map((s: { sportId: number }) => s.sportId)).toEqual([w.football.id]);
    expect((await api().get(`${V1}/public/players`).query({ sportId: w.cricket.id })).body.data).toEqual([]);
  });

  it("lists and serves only open, upcoming requests from active posters", async () => {
    const poster = await recruiterUser(w, "poster@example.com");
    const open = await makeRequest(w, poster.user.id, { venueText: "Open ground" });
    const filled = await makeRequest(w, poster.user.id, { status: "FILLED", playersNeeded: 1, playersAccepted: 1 });
    const cancelled = await makeRequest(w, poster.user.id, { status: "CANCELLED" });
    const completed = await makeRequest(w, poster.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-30) });
    const past = await makeRequest(w, poster.user.id, { matchAt: hoursFromNow(-2) });
    const hidden = await makeRequest(w, poster.user.id, { isHidden: true });
    const other = await recruiterUser(w, "suspended@example.com");
    const fromSuspended = await makeRequest(w, other.user.id);
    await prisma.user.update({ where: { id: other.user.id }, data: { status: "SUSPENDED" } });

    const list = await api().get(`${V1}/public/requests`);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([open.id]);
    expect((await api().get(`${V1}/public/requests/${open.id}`)).status).toBe(200);
    for (const r of [filled, cancelled, completed, past, hidden, fromSuspended]) {
      expect((await api().get(`${V1}/public/requests/${r.id}`)).status).toBe(404);
    }
  });

  it("never exposes contact details on public requests", async () => {
    const poster = await recruiterUser(w, "contact@example.com");
    const open = await makeRequest(w, poster.user.id);
    const body = JSON.stringify((await api().get(`${V1}/public/requests/${open.id}`)).body);
    expect(body).not.toMatch(/phone|@example\.com/i);
  });
});
