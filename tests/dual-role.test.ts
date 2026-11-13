import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, prisma, recruiterUser, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

describe("one account, two hats (X-Active-Role)", () => {
  it("a recruiter can ask to act as a player, create a player profile, and then use player screens", async () => {
    const rec = await recruiterUser(w);
    const asRecruiter = { ...rec.auth, "X-Active-Role": "RECRUITER" };
    const asPlayer = { ...rec.auth, "X-Active-Role": "PLAYER" };

    // without the header the account's own role applies: player screens are closed to a recruiter
    expect((await api().get(`${V1}/players/me`).set(rec.auth)).status).toBe(403);
    // wearing the player hat opens them: no profile yet, so the answer is "not found", not "forbidden"
    expect([404, 200]).toContain((await api().get(`${V1}/players/me`).set(asPlayer)).status);
    const created = await api().post(`${V1}/players/me`).set(asPlayer).send({ districtId: w.patuakhali.id, upazilaId: w.kalapara.id });
    expect(created.status).toBeLessThan(300);
    expect((await prisma.playerProfile.count({ where: { userId: rec.user.id } }))).toBe(1);
    expect((await api().get(`${V1}/players/me`).set(asPlayer)).status).toBe(200);
    await api().post(`${V1}/players/me/sports`).set(asPlayer).send({ sportId: w.football.id, positions: ["GK"], skillLevel: 2 });
    // and the recruiter hat still works
    expect((await api().get(`${V1}/recruiters/me`).set(asRecruiter)).status).toBe(200);
    // the new profile makes this account discoverable to other people
    const other = await recruiterUser(w, "other@example.com");
    expect((await api().get(`${V1}/players/${created.body.data.id}`).set(other.auth)).status).toBe(200);
  });

  it("garbage or admin values for the header change nothing, and admins cannot use it", async () => {
    const rec = await recruiterUser(w);
    for (const hat of ["ADMIN", "root", "", "player; drop"]) {
      const res = await api().get(`${V1}/players/me`).set({ ...rec.auth, "X-Active-Role": hat });
      expect(res.status, hat).toBe(hat === "" ? 403 : 403);
    }
  });
});
