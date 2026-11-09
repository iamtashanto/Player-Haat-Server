import { beforeEach, describe, expect, it } from "vitest";
import { haversineKm } from "../src/modules/locations/locations.service.js";
import { V1, api, prisma, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  // Patuakhali (south) and Dhaka (centre), centres as in bd-geo-info
  await prisma.district.update({ where: { id: w.patuakhali.id }, data: { lat: 22.3596, lng: 90.3291 } });
  await prisma.district.update({ where: { id: w.dhaka.id }, data: { lat: 23.8103, lng: 90.4125 } });
});

describe("GET /locations/nearest", () => {
  it("returns the nearest district first, with its division and a distance, without signing in", async () => {
    const r = await api().get(`${V1}/locations/nearest`).query({ lat: 22.3, lng: 90.4 }); // near Patuakhali
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: { nameEn: string }) => d.nameEn)).toEqual(["Patuakhali", "Dhaka"]);
    expect(r.body.data[0]).toMatchObject({ level: "district", id: w.patuakhali.id, division: { nameEn: "Barishal" } });
    expect(r.body.data[0].distanceKm).toBeLessThan(15);
    expect(r.body.data[1].distanceKm).toBeGreaterThan(100);

    const north = await api().get(`${V1}/locations/nearest`).query({ lat: 23.9, lng: 90.4, limit: 1 });
    expect(north.body.data).toHaveLength(1);
    expect(north.body.data[0].nameEn).toBe("Dhaka");
  });

  it("skips districts without coordinates and rejects points outside Bangladesh or malformed input", async () => {
    await prisma.district.update({ where: { id: w.dhaka.id }, data: { lat: null, lng: null } });
    const r = await api().get(`${V1}/locations/nearest`).query({ lat: 23.8, lng: 90.4 });
    expect(r.body.data.map((d: { nameEn: string }) => d.nameEn)).toEqual(["Patuakhali"]);
    for (const q of [{ lat: 51.5, lng: -0.12 }, { lat: "x", lng: 90 }, { lat: 22 }, { lat: 22, lng: 90, limit: 99 }]) {
      expect((await api().get(`${V1}/locations/nearest`).query(q)).status).toBe(422);
    }
  });

  it("does not store the coordinate anywhere", async () => {
    const before = await prisma.user.count();
    await api().get(`${V1}/locations/nearest`).query({ lat: 22.3, lng: 90.4 });
    expect(await prisma.user.count()).toBe(before);
  });

  it("haversine matches a known distance (Dhaka ↔ Chattogram ≈ 215 km)", () => {
    expect(haversineKm(23.8103, 90.4125, 22.3569, 91.7832)).toBeGreaterThan(200);
    expect(haversineKm(23.8103, 90.4125, 22.3569, 91.7832)).toBeLessThan(230);
    expect(haversineKm(23.8, 90.4, 23.8, 90.4)).toBe(0);
  });
});
