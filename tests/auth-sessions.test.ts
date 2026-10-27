import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER, V1, api, bearer, login, prisma, registerUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

const refresh = (refreshToken: string) => api().post(`${V1}/auth/refresh`).send({ refreshToken });

describe("refresh-token rotation", () => {
  it("issues a new pair and consumes the old token", async () => {
    const { refreshToken } = await registerUser();
    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(refreshToken);
    expect(res.body.data.accessToken).toBeTruthy();

    // The new access token works.
    const me = await api().get(`${V1}/auth/methods`).set(bearer(res.body.data.accessToken));
    expect(me.status).toBe(200);
  });

  it("links tokens into a chain (replacedBy) within one family", async () => {
    const { refreshToken } = await registerUser();
    const next = (await refresh(refreshToken)).body.data.refreshToken as string;
    await refresh(next);
    const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows[0]!.replacedById).toBe(rows[1]!.id);
    expect(rows[1]!.replacedById).toBe(rows[2]!.id);
    expect(rows[2]!.revokedAt).toBeNull();
  });

  it("detects reuse of a rotated token and revokes the whole family", async () => {
    const { refreshToken: t1 } = await registerUser();
    const t2 = (await refresh(t1)).body.data.refreshToken as string;

    const replay = await refresh(t1); // attacker (or buggy client) replays the old token
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("AUTH_REFRESH_REUSED");

    // The legitimate holder's current token is dead too.
    const victim = await refresh(t2);
    expect(victim.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("does not touch other devices' sessions when one family is revoked", async () => {
    const a = await registerUser({ deviceId: "phone" });
    const other = (await login(DEFAULT_USER.email, DEFAULT_USER.password, "tablet")).body.data.tokens.refreshToken as string;

    const t2 = (await refresh(a.refreshToken)).body.data.refreshToken as string;
    await refresh(a.refreshToken); // replay on the phone family
    expect((await refresh(t2)).status).toBe(401);
    expect((await refresh(other)).status).toBe(200); // tablet unaffected
  });

  it("lets exactly one of two concurrent refreshes win (compare-and-set)", async () => {
    const { refreshToken } = await registerUser();
    const [r1, r2] = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const loser = r1.status === 401 ? r1 : r2;
    expect(loser.body.error.code).toBe("AUTH_REFRESH_REUSED");
  });

  it("rejects unknown, malformed and expired tokens", async () => {
    const unknown = await refresh("x".repeat(64));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("AUTH_INVALID_REFRESH_TOKEN");
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken: "short" })).status).toBe(422);

    const { refreshToken } = await registerUser();
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await refresh(refreshToken);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("AUTH_REFRESH_EXPIRED");
  });

  it("refuses to refresh for a suspended user and revokes the family", async () => {
    const { refreshToken, user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    const res = await refresh(refreshToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });
});

describe("logout", () => {
  it("revokes this device only", async () => {
    const phone = await registerUser({ deviceId: "phone" });
    const tablet = (await login(DEFAULT_USER.email, DEFAULT_USER.password, "tablet")).body.data.tokens.refreshToken as string;

    const res = await api().post(`${V1}/auth/logout`).send({ refreshToken: phone.refreshToken });
    expect(res.status).toBe(200);
    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect((await refresh(tablet)).status).toBe(200);
  });

  it("a logged-out token is 'invalid', not a reuse alarm", async () => {
    const { refreshToken } = await registerUser();
    await api().post(`${V1}/auth/logout`).send({ refreshToken });
    const res = await refresh(refreshToken);
    expect(res.body.error.code).toBe("AUTH_INVALID_REFRESH_TOKEN");
  });

  it("is idempotent and ignores unknown tokens", async () => {
    const { refreshToken } = await registerUser();
    expect((await api().post(`${V1}/auth/logout`).send({ refreshToken })).status).toBe(200);
    expect((await api().post(`${V1}/auth/logout`).send({ refreshToken })).status).toBe(200);
    expect((await api().post(`${V1}/auth/logout`).send({ refreshToken: "z".repeat(64) })).status).toBe(200);
  });

  it("logout-all revokes every device", async () => {
    const phone = await registerUser({ deviceId: "phone" });
    const tablet = (await login(DEFAULT_USER.email, DEFAULT_USER.password, "tablet")).body.data.tokens.refreshToken as string;

    const res = await api().post(`${V1}/auth/logout-all`).set(bearer(phone.accessToken));
    expect(res.status).toBe(200);
    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect((await refresh(tablet)).status).toBe(401);
  });

  it("logout-all requires authentication", async () => {
    expect((await api().post(`${V1}/auth/logout-all`)).status).toBe(401);
  });
});
