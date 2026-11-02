import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, playerUser, prisma, resetDb, seedWorld, type World } from "./helpers.js";

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
});
