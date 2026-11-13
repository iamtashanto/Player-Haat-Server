import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { locate } from "./boundaries.js";

const base = { id: true, nameBn: true, nameEn: true, slug: true } as const;

export const listDivisions = () => prisma.division.findMany({ select: base, orderBy: { nameEn: "asc" } });

export const listDistricts = (divisionId: number) =>
  prisma.district.findMany({ where: { divisionId }, select: { ...base, divisionId: true }, orderBy: { nameEn: "asc" } });

export const listUpazilas = (districtId: number) =>
  prisma.upazila.findMany({ where: { districtId }, select: { ...base, districtId: true }, orderBy: { nameEn: "asc" } });

export const listUnions = (upazilaId: number) =>
  prisma.union.findMany({ where: { upazilaId }, select: { ...base, upazilaId: true }, orderBy: { nameEn: "asc" } });

export type LocationLevel = "district" | "upazila" | "union";

type NameFilter = { OR: Array<{ nameEn: { contains: string; mode: "insensitive" } } | { nameBn: { contains: string } }> };
const nameHas = (tok: string): NameFilter => ({ OR: [{ nameEn: { contains: tok, mode: "insensitive" } }, { nameBn: { contains: tok } }] });
const ref = { select: { id: true, nameBn: true, nameEn: true } } as const;

/**
 * "Type any part of the address": Bangla or English, one or several words, in any order. Every word must match the
 * place itself or one of its parents, so "latachapli kalapara", "kalapara patuakhali" and "পটুয়াখালী কলাপাড়া" all work.
 * Ranking: places whose OWN name matches every word come first (prefix matches before substring), then places that
 * match only through their parents (e.g. the unions of a searched upazila); ties go district, upazila, union, then shorter names.
 * Each result carries the full chain (division, district, upazila) so choosing it fills the whole address.
 */
export async function searchLocations(q: string, levels: LocationLevel[], limit: number) {
  const tokens = q.split(/[\s,،;]+/).filter(Boolean).slice(0, 4);
  if (tokens.length === 0) return [];
  const per = limit * 3; // over-fetch a little so ranking has something to choose from
  const each = (...chain: string[]) => ({
    AND: tokens.map((tok) => ({ OR: [...nameHas(tok).OR, ...chain.map((rel) => relFilter(rel, nameHas(tok)))] })),
  });

  const [districts, upazilas, unions] = await Promise.all([
    levels.includes("district")
      ? prisma.district.findMany({ where: each("division"), take: per, select: { id: true, nameBn: true, nameEn: true, division: ref } })
      : [],
    levels.includes("upazila")
      ? prisma.upazila.findMany({
          where: each("district", "district.division"),
          take: per,
          select: { id: true, nameBn: true, nameEn: true, district: { select: { id: true, nameBn: true, nameEn: true, division: ref } } },
        })
      : [],
    levels.includes("union")
      ? prisma.union.findMany({
          where: each("upazila", "upazila.district", "upazila.district.division"),
          take: per,
          select: {
            id: true,
            nameBn: true,
            nameEn: true,
            upazila: { select: { id: true, nameBn: true, nameEn: true, district: { select: { id: true, nameBn: true, nameEn: true, division: ref } } } },
          },
        })
      : [],
  ]);

  // A 4-digit token is a post code: it finds the upazilas that have a post office with that code.
  const codeTok = tokens.find((t) => /^\d{4}$/.test(t));
  const byCode =
    codeTok && levels.includes("upazila")
      ? await prisma.upazila.findMany({
          where: { postOffices: { some: { code: codeTok } } },
          take: per,
          select: { id: true, nameBn: true, nameEn: true, district: { select: { id: true, nameBn: true, nameEn: true, division: ref } } },
        })
      : [];

  const lower = tokens.map((t) => t.toLowerCase());
  const has = (r: { nameEn: string; nameBn: string }, tok: string, i: number) => r.nameEn.toLowerCase().includes(lower[i]!) || r.nameBn.includes(tok);
  const score = (r: { nameEn: string; nameBn: string }, order: number) => {
    const own = tokens.every((tok, i) => has(r, tok, i));
    const prefix = r.nameEn.toLowerCase().startsWith(lower[0]!) || r.nameBn.startsWith(tokens[0]!);
    return (own ? (prefix ? 0 : 1) : 2) * 100_000 + order * 10_000 + r.nameEn.length;
  };

  const all = [
    ...districts.map((d) => ({ level: "district" as const, id: d.id, nameBn: d.nameBn, nameEn: d.nameEn, division: d.division, district: null, upazila: null, _s: score(d, 0) })),
    ...byCode.map((u) => ({ level: "upazila" as const, id: u.id, nameBn: u.nameBn, nameEn: u.nameEn, division: u.district.division, district: { id: u.district.id, nameBn: u.district.nameBn, nameEn: u.district.nameEn }, upazila: null, _s: -1 })),
    ...upazilas.map((u) => ({ level: "upazila" as const, id: u.id, nameBn: u.nameBn, nameEn: u.nameEn, division: u.district.division, district: { id: u.district.id, nameBn: u.district.nameBn, nameEn: u.district.nameEn }, upazila: null, _s: score(u, 1) })),
    ...unions.map((u) => ({
      level: "union" as const,
      id: u.id,
      nameBn: u.nameBn,
      nameEn: u.nameEn,
      division: u.upazila.district.division,
      district: { id: u.upazila.district.id, nameBn: u.upazila.district.nameBn, nameEn: u.upazila.district.nameEn },
      upazila: { id: u.upazila.id, nameBn: u.upazila.nameBn, nameEn: u.upazila.nameEn },
      _s: score(u, 2),
    })),
  ];
  const seen = new Set<string>();
  const top = all
    .sort((a, b) => a._s - b._s)
    .filter((r) => (seen.has(`${r.level}${r.id}`) ? false : (seen.add(`${r.level}${r.id}`), true)))
    .slice(0, limit);
  // Post codes ride along: those of the upazila (for an upazila or union hit), so the address can be written out in full.
  const upazilaIds = [...new Set(top.flatMap((r) => (r.level === "upazila" ? [r.id] : r.level === "union" && r.upazila ? [r.upazila.id] : [])))];
  const offices = upazilaIds.length ? await prisma.postOffice.findMany({ where: { upazilaId: { in: upazilaIds } }, orderBy: { code: "asc" }, select: { upazilaId: true, code: true, nameEn: true } }) : [];
  const codesOf = (upazilaId: number) => offices.filter((o) => o.upazilaId === upazilaId).map((o) => ({ code: o.code, office: o.nameEn }));
  return top.map(({ _s, ...r }) => ({ ...r, postcodes: r.level === "upazila" ? codesOf(r.id) : r.level === "union" && r.upazila ? codesOf(r.upazila.id) : [] }));
}

/** `relFilter("upazila.district", f)` => { upazila: { district: f } } */
function relFilter(path: string, f: NameFilter): Record<string, unknown> {
  return path.split(".").reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), f as unknown as Record<string, unknown>);
}



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
