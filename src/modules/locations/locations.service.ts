import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { locate } from "./boundaries.js";
import { logger } from "../../lib/logger.js";

/**
 * "Approximately where am I", from the internet connection, for when the phone or browser cannot give a GPS position
 * (Brave without location services, desktops, blocked sensors). Free, no key: ipwho.is. Only the visitor's own address is
 * sent, nothing is stored, and the answer is a town-level guess: always shown as approximate.
 */
export const ipDeps = { fetch: (url: string, init?: RequestInit) => fetch(url, init) as Promise<Response> };
const ipCache = new Map<string, { at: number; v: { lat: number; lng: number } | null }>();
const IP_TTL = 60 * 60 * 1000;
const isLocal = (ip: string) => !ip || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.") || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(ip);

export async function approximatePoint(ip: string): Promise<{ lat: number; lng: number } | null> {
  const key = isLocal(ip) ? "self" : ip; // on a developer machine ask about the machine's own public address
  const hit = ipCache.get(key);
  if (hit && Date.now() - hit.at < IP_TTL) return hit.v;
  try {
    const res = await ipDeps.fetch(`https://ipwho.is/${key === "self" ? "" : encodeURIComponent(key)}?fields=success,latitude,longitude,country_code`, { signal: AbortSignal.timeout(4000) });
    const j = (await res.json()) as { success?: boolean; latitude?: number; longitude?: number; country_code?: string };
    const v = j.success && j.country_code === "BD" && typeof j.latitude === "number" && typeof j.longitude === "number" ? { lat: Math.round(j.latitude * 100) / 100, lng: Math.round(j.longitude * 100) / 100 } : null;
    ipCache.set(key, { at: Date.now(), v });
    return v;
  } catch (err) {
    logger.warn({ err }, "ip lookup failed");
    return null;
  }
}

export const clearIpCache = () => ipCache.clear();

const base = { id: true, nameBn: true, nameEn: true, slug: true } as const;

export const listDivisions = () => prisma.division.findMany({ select: base, orderBy: { nameEn: "asc" } });

export const listDistricts = (divisionId: number) =>
  prisma.district.findMany({ where: { divisionId }, select: { ...base, divisionId: true, lat: true, lng: true }, orderBy: { nameEn: "asc" } });

export const listUpazilas = (districtId: number) =>
  prisma.upazila.findMany({ where: { districtId }, select: { ...base, districtId: true, lat: true, lng: true }, orderBy: { nameEn: "asc" } });

export const listUnions = (upazilaId: number) =>
  prisma.union.findMany({ where: { upazilaId }, select: { ...base, upazilaId: true }, orderBy: { nameEn: "asc" } });

export type LocationLevel = "district" | "upazila" | "union" | "place";

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

  const placesQ = levels.includes("place")
    ? prisma.place.findMany({
        where: {
          AND: tokens.map((tok) => ({
            OR: [...nameHas(tok).OR, { upazila: nameHas(tok) }, { district: nameHas(tok) }],
          })),
        },
        take: per,
        orderBy: { nameEn: "asc" },
        select: {
          id: true, nameBn: true, nameEn: true, kind: true, lat: true, lng: true,
          upazila: { select: { id: true, nameBn: true, nameEn: true } },
          district: { select: { id: true, nameBn: true, nameEn: true, division: ref } },
        },
      })
    : [];
  const [districts, upazilas, unions, placeRows] = await Promise.all([
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
    placesQ,
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
    ...placeRows.map((p) => ({
      level: "place" as const,
      id: p.id,
      nameBn: p.nameBn ?? p.nameEn,
      nameEn: p.nameEn,
      kind: p.kind,
      lat: p.lat,
      lng: p.lng,
      division: p.district.division,
      district: { id: p.district.id, nameBn: p.district.nameBn, nameEn: p.district.nameEn },
      upazila: p.upazila,
      _s: score({ nameEn: p.nameEn, nameBn: p.nameBn ?? "" }, 3) - (p.kind === "BEACH" || p.kind === "TOWN" || p.kind === "ISLAND" ? 1000 : 0), // well-known kinds first among equals
    })),
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
  return top.map(({ _s, ...r }) => ({ ...r, kind: "kind" in r ? (r as { kind: string }).kind : undefined, postcodes: r.level === "upazila" ? codesOf(r.id) : r.level === "union" && r.upazila ? codesOf(r.upazila.id) : [] }));
}

/** `relFilter("upazila.district", f)` => { upazila: { district: f } } */
function relFilter(path: string, f: NameFilter): Record<string, unknown> {
  return path.split(".").reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), f as unknown as Record<string, unknown>);
}



export async function areaByIp(ip: string) {
  const p = await approximatePoint(ip);
  if (!p) throw AppError.notFound(undefined, "Could not work out an area for this connection");
  return { ...(await containingArea(p.lat, p.lng)), lat: p.lat, lng: p.lng, approximate: true as const };
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
