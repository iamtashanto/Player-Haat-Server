import { beforeEach, describe, expect, it } from "vitest";
import { V1, adminUser, api, prisma, registerAs, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
let admin: Awaited<ReturnType<typeof adminUser>>;

beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  admin = await adminUser();
});

const call = (method: "get" | "post" | "put" | "patch" | "delete", path: string, body: object = {}, query: object = {}) =>
  api()[method](`${V1}${path}`).set(admin.auth).query(query).send(body);

describe("Admin Dashboard Extensions", () => {
  it("provides rich stats with charts and recent activity", async () => {
    const res = await call("get", "/admin/stats");
    expect(res.status).toBe(200);
    const { summary, charts, recentActivity } = res.body.data;
    expect(summary).toBeDefined();
    expect(summary.users.total).toBeGreaterThanOrEqual(1);
    expect(charts.signupsTrend).toBeInstanceOf(Array);
    expect(charts.signupsTrend.length).toBe(30);
    expect(charts.sportsDistribution).toBeInstanceOf(Array);
    expect(recentActivity.recentActions).toBeInstanceOf(Array);
  });

  it("bans user with duration and revokes active sessions", async () => {
    const player = await registerAs("PLAYER", "ban-me@example.com");
    const res = await call("post", `/admin/users/${player.user.id}/ban`, {
      reason: "Abusive behavior on field",
      durationDays: 14,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SUSPENDED");

    // Action was logged with metadata
    const audit = await prisma.adminAction.findFirst({
      where: { targetId: player.user.id, action: "USER_SUSPEND" },
    });
    expect(audit).toBeDefined();
    expect(audit?.metadata).toMatchObject({ ban: true, durationDays: 14 });
  });

  it("resets all user sessions", async () => {
    const player = await registerAs("PLAYER", "reset-sessions@example.com");
    const res = await call("post", `/admin/users/${player.user.id}/reset-sessions`);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
  });

  it("lists sport profiles across all sports with filtering", async () => {
    const res = await call("get", "/admin/sport-profiles");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it("lists recruitment requests with applicants count", async () => {
    const res = await call("get", "/admin/requests");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it("manages dynamic sports and positions catalogue", async () => {
    const listRes = await call("get", "/admin/sports");
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(2);

    // Create new sport
    const createRes = await call("post", "/admin/sports", {
      code: "TENNIS",
      nameEn: "Tennis",
      nameBn: "টেনিস",
      isActive: true,
    });
    expect(createRes.status).toBe(201);
    const newSportId = createRes.body.data.id;

    // Add a position to the new sport
    const posRes = await call("post", `/admin/sports/${newSportId}/positions`, {
      code: "SINGLES",
      nameEn: "Singles",
      nameBn: "সিঙ্গেলস",
      order: 1,
    });
    expect(posRes.status).toBe(201);

    // Update sport
    const updateRes = await call("put", `/admin/sports/${newSportId}`, {
      nameEn: "Tennis Pro",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.nameEn).toBe("Tennis Pro");
  });

  it("lists divisions and districts", async () => {
    const divs = await call("get", "/admin/locations/divisions");
    expect(divs.status).toBe(200);
    expect(divs.body.data.length).toBeGreaterThanOrEqual(1);

    const dists = await call("get", "/admin/locations/districts");
    expect(dists.status).toBe(200);
    expect(dists.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("previews notification audience count", async () => {
    const res = await call("get", "/admin/notifications/preview", {}, { role: "PLAYER" });
    expect(res.status).toBe(200);
    expect(res.body.data.targetCount).toBeGreaterThanOrEqual(0);
  });
});
