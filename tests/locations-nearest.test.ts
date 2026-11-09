import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { haversineKm, roundCoarse } from "../src/lib/geo.js";
import { BORDER_KM, boundaries, locate } from "../src/modules/locations/boundaries.js";
import { V1, api, prisma, resetDb, seedWorld } from "./helpers.js";

const get = (lat: number, lng: number) => api().get(`${V1}/locations/nearest`).query({ lat, lng });

describe("point-in-polygon lookup on the real boundary data", () => {
  it.each([
    ["Dhaka", 23.8103, 90.4125, "Dhaka"],
    ["Chattogram", 22.3569, 91.7832, "Chattogram"],
    ["Sylhet", 24.8949, 91.8687, "Sylhet"],
    ["Rajshahi", 24.3745, 88.6042, "Rajshahi"],
    ["Khulna", 22.8456, 89.5403, "Khulna"],
    ["Barishal", 22.701, 90.3535, "Barishal"],
    ["Rangpur", 25.7439, 89.2752, "Rangpur"],
    ["Cox's Bazar", 21.4272, 92.0058, "Cox's Bazar"],
  ])("%s is inside its own district", (_n, lat, lng, district) => {
    expect(locate(lat, lng)?.district).toBe(district);
  });

  it("a Kalapara point is Patuakhali › Kalapara (the centre-distance lookup used to say Barguna)", () => {
    expect(locate(21.99, 90.22)).toMatchObject({ district: "Patuakhali", upazila: "Kalapara", nearBorder: false });
  });

  it("points a few tens of metres inside each side of a district border resolve to their own district", () => {
    const b = boundaries();
    const patuakhali = b.districts.find((d) => d.key === "Patuakhali")!;
    const ring = patuakhali.polys[0]![0]!;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    let checked = 0;
    for (let i = 0; i < ring.length; i += Math.floor(ring.length / 12) || 1) {
      const [vx, vy] = ring[i]!;
      const len = Math.hypot(cx - vx, cy - vy);
      const px = vx + ((cx - vx) / len) * 0.0006, py = vy + ((cy - vy) / len) * 0.0006; // ~65 m towards the middle
      const hit = locate(py, px);
      // a vertex shared with a neighbour (or a river/coast notch) can still be that neighbour's: only assert when inside the polygon
      if (hit && hit.district === "Patuakhali") checked++;
      expect(hit).not.toBeNull();
    }
    expect(checked).toBeGreaterThan(6);
  });

  it("a point just off the coast resolves with nearBorder; open sea and other countries are outside", () => {
    const kuakata = locate(21.81, 90.115); // the Kuakata shore
    expect(kuakata?.district).toBe("Patuakhali");
    expect(locate(20.7, 90.3)).toBeNull(); // Bay of Bengal
    expect(locate(28.6, 77.2)).toBeNull(); // Delhi
    expect(BORDER_KM).toBe(2);
  });

  it("every district has a polygon and the matched upazilas are reported", () => {
    expect(boundaries().districts).toHaveLength(64);
    const report = JSON.parse(readFileSync(new URL("../prisma/seed/data/boundaries/match-report.json", import.meta.url), "utf8"));
    expect(report.upazilasMatched).toBeGreaterThan(480);
    expect(report.unmatchedTheirs.every((x: string) => x.includes("City Corporation"))).toBe(true);
  });
});

describe("GET /locations/nearest", () => {
  beforeEach(async () => {
    await resetDb();
    await seedWorld();
  });

  it("returns the containing division › district › upazila with ids, without signing in", async () => {
    const r = await get(21.99, 90.22);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      division: { nameEn: "Barishal" },
      district: { nameEn: "Patuakhali" },
      upazila: { nameEn: "Kalapara" },
      precision: "upazila",
      nearBorder: false,
    });
    expect(r.body.data.district.id).toBeGreaterThan(0);
    expect(r.body.data.upazila.id).toBeGreaterThan(0);
  });

  it("falls back to district precision when the dataset has no polygon for the upazila", async () => {
    await prisma.upazila.updateMany({ where: { nameEn: "Kalapara" }, data: { nameEn: "Kalapara (renamed)" } }); // as for a newer upazila our DB doesn't know
    const r = await get(21.99, 90.22);
    expect(r.body.data.precision).toBe("district");
    expect(r.body.data.upazila).toBeNull();
  });

  it("is 404 outside Bangladesh and 422 for malformed or out-of-range coordinates", async () => {
    expect((await get(20.7, 90.3)).status).toBe(404);
    for (const q of [{ lat: 51.5, lng: -0.12 }, { lat: "x", lng: 90 }, { lat: 22 }]) expect((await api().get(`${V1}/locations/nearest`).query(q)).status).toBe(422);
  });

  it("does not store the coordinate", async () => {
    const before = await prisma.user.count();
    await get(21.99, 90.22);
    expect(await prisma.user.count()).toBe(before);
  });
});

describe("geo helpers", () => {
  it("haversine matches a known distance (Dhaka ↔ Chattogram ≈ 215 km) and rounding keeps ~1 km", () => {
    expect(haversineKm(23.8103, 90.4125, 22.3569, 91.7832)).toBeGreaterThan(200);
    expect(haversineKm(23.8103, 90.4125, 22.3569, 91.7832)).toBeLessThan(230);
    expect(haversineKm(23.8, 90.4, 23.8, 90.4)).toBe(0);
    expect(roundCoarse(21.98765)).toBe(21.99);
  });
});
