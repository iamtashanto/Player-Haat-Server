import { prisma } from "../../lib/prisma.js";

const base = { id: true, nameBn: true, nameEn: true, slug: true } as const;

export const listDivisions = () => prisma.division.findMany({ select: base, orderBy: { nameEn: "asc" } });

export const listDistricts = (divisionId: number) =>
  prisma.district.findMany({ where: { divisionId }, select: { ...base, divisionId: true }, orderBy: { nameEn: "asc" } });

export const listUpazilas = (districtId: number) =>
  prisma.upazila.findMany({ where: { districtId }, select: { ...base, districtId: true }, orderBy: { nameEn: "asc" } });

export const listUnions = (upazilaId: number) =>
  prisma.union.findMany({ where: { upazilaId }, select: { ...base, upazilaId: true }, orderBy: { nameEn: "asc" } });

export type LocationLevel = "district" | "upazila" | "union";

/**
 * Name search across Bangla and English. Case-insensitive substring match (Postgres ILIKE).
 * Ranking: names that START with the query come first, then shorter names.
 * (Phase 6: add a pg_trgm index if this shows up in load tests.)
 */
export async function searchLocations(q: string, levels: LocationLevel[], limit: number) {
  const name = { OR: [{ nameEn: { contains: q, mode: "insensitive" as const } }, { nameBn: { contains: q } }] };
  const [districts, upazilas, unions] = await Promise.all([
    levels.includes("district")
      ? prisma.district.findMany({ where: name, take: limit, select: { id: true, nameBn: true, nameEn: true } })
      : [],
    levels.includes("upazila")
      ? prisma.upazila.findMany({
          where: name,
          take: limit,
          select: { id: true, nameBn: true, nameEn: true, district: { select: { id: true, nameBn: true, nameEn: true } } },
        })
      : [],
    levels.includes("union")
      ? prisma.union.findMany({
          where: name,
          take: limit,
          select: {
            id: true,
            nameBn: true,
            nameEn: true,
            upazila: { select: { id: true, nameBn: true, nameEn: true, district: { select: { id: true, nameBn: true, nameEn: true } } } },
          },
        })
      : [],
  ]);

  const needle = q.toLowerCase();
  const rank = (r: { nameEn: string; nameBn: string }) =>
    (r.nameEn.toLowerCase().startsWith(needle) || r.nameBn.startsWith(q) ? 0 : 1) * 1000 + r.nameEn.length;

  return [
    ...districts.map((d) => ({ level: "district" as const, id: d.id, nameBn: d.nameBn, nameEn: d.nameEn, district: null, upazila: null })),
    ...upazilas.map((u) => ({ level: "upazila" as const, id: u.id, nameBn: u.nameBn, nameEn: u.nameEn, district: u.district, upazila: null })),
    ...unions.map((u) => ({
      level: "union" as const,
      id: u.id,
      nameBn: u.nameBn,
      nameEn: u.nameEn,
      district: u.upazila.district,
      upazila: { id: u.upazila.id, nameBn: u.upazila.nameBn, nameEn: u.upazila.nameEn },
    })),
  ]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

import { AppError } from "../../lib/errors.js";
import { locate } from "./boundaries.js";

/**
 * The district and upazila that CONTAIN a point (polygons from OCHA/HDX COD-AB, in memory), with parents and ids.
 * Upazila is null where the dataset has no polygon (city-corporation thanas, newer upazilas): the client then asks the
 * user to pick it. Unions have no boundary data, so they stay a manual pick (the client pre-filters by upazila).
 * The coordinate is used for this lookup only: never stored, never logged.
 */
export async function containingArea(lat: number, lng: number) {
  const hit = locate(lat, lng);
  if (!hit) throw AppError.notFound(undefined, "No Bangladesh area at this point");
  const district = await prisma.district.findFirst({
    where: { nameEn: hit.district },
    select: { id: true, nameBn: true, nameEn: true, division: { select: { id: true, nameBn: true, nameEn: true } } },
  });
  if (!district) throw AppError.notFound(undefined, "No Bangladesh area at this point");
  const upazila = hit.upazila
    ? await prisma.upazila.findFirst({ where: { districtId: district.id, nameEn: hit.upazila }, select: { id: true, nameBn: true, nameEn: true } })
    : null;
  const { division, ...d } = district;
  return { division, district: d, upazila, precision: upazila ? ("upazila" as const) : ("district" as const), nearBorder: hit.nearBorder };
}
