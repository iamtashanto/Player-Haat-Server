import { beforeEach, describe, expect, it } from "vitest";
import { compareVersions } from "../src/modules/app-config/app-config.service.js";
import { V1, adminUser, api, prisma, resetDb, seedWorld } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  await seedWorld();
});

const DEFAULT_PRICING = { contactCreditsEnabled: false, freeContactsPerDay: 5, contactCreditCost: 1, boostCreditCost: 10, boostHours: 48 };
const cfg = (query: Record<string, string> = {}) => api().get(`${V1}/app-config`).query(query);

describe("GET /app-config (public)", () => {
  it("works without auth and falls back to safe defaults when nothing is stored", async () => {
    const res = await cfg();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ flags: { ads_enabled: false, boost_enabled: false, contact_credits_enabled: false }, pricing: DEFAULT_PRICING, minAppVersion: "0.0.0" });
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });

  it("reflects stored values", async () => {
    await prisma.appConfig.createMany({
      data: [
        { key: "ads_enabled", value: true },
        { key: "boost_enabled", value: false },
        { key: "min_app_version", value: "1.4.0" },
      ],
    });
    expect((await cfg()).body.data).toEqual({ flags: { ads_enabled: true, boost_enabled: false, contact_credits_enabled: false }, pricing: DEFAULT_PRICING, minAppVersion: "1.4.0" });
  });

  it("a corrupt stored value falls back to the default instead of breaking every app launch", async () => {
    await prisma.appConfig.createMany({ data: [{ key: "ads_enabled", value: "yes please" }, { key: "min_app_version", value: { nope: 1 } }] });
    expect((await cfg()).body.data).toEqual({ flags: { ads_enabled: false, boost_enabled: false, contact_credits_enabled: false }, pricing: DEFAULT_PRICING, minAppVersion: "0.0.0" });
  });

  it("tells an outdated app to update when it sends its version", async () => {
    await prisma.appConfig.create({ data: { key: "min_app_version", value: "1.10.0" } });
    expect((await cfg({ appVersion: "1.9.2" })).body.data.updateRequired).toBe(true);
    expect((await cfg({ appVersion: "1.10.0" })).body.data.updateRequired).toBe(false);
    expect((await cfg({ appVersion: "2.0" })).body.data.updateRequired).toBe(false);
    expect((await cfg()).body.data).not.toHaveProperty("updateRequired");
    expect((await cfg({ appVersion: "banana" })).status).toBe(422);
  });

  it("serves from a short in-process cache, which an admin change clears at once", async () => {
    const admin = await adminUser();
    await cfg(); // warm the cache with defaults
    await prisma.appConfig.create({ data: { key: "ads_enabled", value: true } }); // behind the cache's back
    expect((await cfg()).body.data.flags.ads_enabled).toBe(false); // still cached

    await api().put(`${V1}/admin/app-config/boost_enabled`).set(admin.auth).send({ value: true });
    const after = (await cfg()).body.data;
    expect(after.flags).toEqual({ ads_enabled: true, boost_enabled: true, contact_credits_enabled: false }); // cache cleared → fresh read
  });
});

describe("compareVersions", () => {
  it.each([
    ["1.10.0", "1.9.2", 1],
    ["1.9.2", "1.10.0", -1],
    ["1.0", "1.0.0", 0],
    ["2", "1.99.99", 1],
    ["0.0.0", "0", 0],
  ])("%s vs %s → %i", (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));
});
