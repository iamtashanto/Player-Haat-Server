import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { demoUpazilas } from "./data/locations-demo.js";
import { districtsByDivision } from "./data/districts.js";
import { divisions } from "./data/divisions.js";
import { slugify } from "./slug.js";

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
        update: { nameEn: d.nameEn, nameBn: d.nameBn },
        create: { divisionId, slug, nameEn: d.nameEn, nameBn: d.nameBn },
      });
      districtIds.set(d.nameEn, row.id);
    }
  }

  const full: UpazilaSeed[] = existsSync(FULL_DATASET)
    ? (JSON.parse(readFileSync(FULL_DATASET, "utf8")) as UpazilaSeed[])
    : [];
  // The full dataset supersedes the demo subset when present.
  const upazilas = full.length > 0 ? full : demoUpazilas;

  let upazilaCount = 0;
  let unionCount = 0;
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
    source: full.length > 0 ? "locations-full.json" : "demo subset (Patuakhali)",
  };
}
