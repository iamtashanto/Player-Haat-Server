import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { demoUpazilas } from "./data/locations-demo.js";
import { districtsByDivision } from "./data/districts.js";
import districtCoords from "./data/district-coords.json" with { type: "json" };
import { divisions } from "./data/divisions.js";
import { slugify } from "./slug.js";

type Ring = [number, number][]; // [lng, lat]
/** Area-weighted centre of the largest polygon: a point that is a sensible map centre for the area. */
function centroid(polys: Ring[][]): { lat: number; lng: number } | null {
  let best: Ring | null = null;
  let bestArea = -1;
  for (const p of polys) {
    const ring = p[0];
    if (!ring || ring.length < 3) continue;
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = ring; }
  }
  if (!best || bestArea <= 0) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const f = best[j]![0] * best[i]![1] - best[i]![0] * best[j]![1];
    a += f;
    cx += (best[j]![0] + best[i]![0]) * f;
    cy += (best[j]![1] + best[i]![1]) * f;
  }
  a *= 0.5;
  return { lat: Math.round((cy / (6 * a)) * 1e5) / 1e5, lng: Math.round((cx / (6 * a)) * 1e5) / 1e5 };
}
const readJson = <T>(rel: string): T | null => {
  const f = fileURLToPath(new URL(rel, import.meta.url));
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
};

/** District centre from bd-geo-info (the package has no upazila/union coordinates). */
const coords = (name: string) => {
  const c = (districtCoords as Record<string, number[]>)[name];
  return c ? { lat: c[0], lng: c[1] } : {};
};

export interface UnionSeed {
  nameEn: string;
  nameBn: string;
  code?: string;
}

export interface UpazilaSeed {
  /** English name of the parent district (unique country-wide except where noted in the README). */
  district: string;
  nameEn: string;
  nameBn: string;
  code?: string;
  unions?: UnionSeed[];
}

const FULL_DATASET = fileURLToPath(new URL("./data/locations-full.json", import.meta.url));

/**
 * Idempotent: every row is upserted on its natural key (slug within parent), so re-running
 * after dropping in `locations-full.json` updates names and adds the rest without duplicates.
 */
export async function seedLocations(prisma: PrismaClient) {
  const divisionIds = new Map<string, number>();
  for (const d of divisions) {
    const slug = slugify(d.nameEn);
    const row = await prisma.division.upsert({
      where: { slug },
      update: { nameEn: d.nameEn, nameBn: d.nameBn },
      create: { slug, nameEn: d.nameEn, nameBn: d.nameBn },
    });
    divisionIds.set(d.nameEn, row.id);
  }

  const districtIds = new Map<string, number>();
  for (const [divisionName, list] of Object.entries(districtsByDivision)) {
    const divisionId = divisionIds.get(divisionName)!;
    for (const d of list) {
      const slug = slugify(d.nameEn);
      const row = await prisma.district.upsert({
        where: { divisionId_slug: { divisionId, slug } },
        update: { nameEn: d.nameEn, nameBn: d.nameBn, ...coords(d.nameEn) },
        create: { divisionId, slug, nameEn: d.nameEn, nameBn: d.nameBn, ...coords(d.nameEn) },
      });
      districtIds.set(d.nameEn, row.id);
    }
  }

  const full: UpazilaSeed[] = existsSync(FULL_DATASET)
    ? (JSON.parse(readFileSync(FULL_DATASET, "utf8")) as UpazilaSeed[])
    : [];
  // The full dataset supersedes the demo subset when present.
  const upazilas = full.length > 0 ? full : demoUpazilas;

  const boundaries = readJson<Record<string, Ring[][]>>("./data/boundaries/upazilas.json") ?? {};
  const postcodes = readJson<Record<string, { office: string; code: string }[]>>("./data/postcodes.json") ?? {};
  let upazilaCount = 0;
  let unionCount = 0;
  let postOfficeCount = 0;
  for (const u of upazilas) {
    const districtId = districtIds.get(u.district);
    if (!districtId) throw new Error(`Unknown district "${u.district}" for upazila "${u.nameEn}"`);
    const slug = slugify(u.nameEn);
    const row = await prisma.upazila.upsert({
      where: { districtId_slug: { districtId, slug } },
      update: { nameEn: u.nameEn, nameBn: u.nameBn, code: u.code ?? null },
      create: { districtId, slug, nameEn: u.nameEn, nameBn: u.nameBn, code: u.code ?? null },
    });
    upazilaCount++;
    const centre = boundaries[`${u.district}|${u.nameEn}`] ? centroid(boundaries[`${u.district}|${u.nameEn}`]!) : null;
    if (centre) await prisma.upazila.update({ where: { id: row.id }, data: centre });
    const offices = postcodes[`${u.district}|${u.nameEn}`];
    if (offices) {
      await prisma.postOffice.deleteMany({ where: { upazilaId: row.id } });
      await prisma.postOffice.createMany({ data: offices.map((o) => ({ upazilaId: row.id, nameEn: o.office, code: o.code })) });
      postOfficeCount += offices.length;
    }

    for (const un of u.unions ?? []) {
      const unionSlug = slugify(un.nameEn);
      await prisma.union.upsert({
        where: { upazilaId_slug: { upazilaId: row.id, slug: unionSlug } },
        update: { nameEn: un.nameEn, nameBn: un.nameBn, code: un.code ?? null },
        create: { upazilaId: row.id, slug: unionSlug, nameEn: un.nameEn, nameBn: un.nameBn, code: un.code ?? null },
      });
      unionCount++;
    }
  }

  return {
    divisions: divisions.length,
    districts: districtIds.size,
    upazilas: upazilaCount,
    unions: unionCount,
    postOffices: postOfficeCount,
    source: full.length > 0 ? "locations-full.json" : "demo subset (Patuakhali)",
  };
}
