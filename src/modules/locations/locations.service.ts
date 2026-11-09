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

const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in km. */
export const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/**
 * The districts nearest to a point, with their division. District centres only: the dataset has no coordinates for
 * upazilas or unions, so callers must let the user confirm (or refine) the finer levels. The point is used for this
 * lookup and is neither stored nor logged.
 */
export async function nearestDistricts(lat: number, lng: number, limit: number) {
  const rows = await prisma.district.findMany({
    where: { lat: { not: null }, lng: { not: null } },
    select: { id: true, nameBn: true, nameEn: true, lat: true, lng: true, division: { select: { id: true, nameBn: true, nameEn: true } } },
  });
  return rows
    .map((d) => ({ level: "district" as const, id: d.id, nameBn: d.nameBn, nameEn: d.nameEn, division: d.division, distanceKm: Math.round(haversineKm(lat, lng, d.lat!, d.lng!) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
