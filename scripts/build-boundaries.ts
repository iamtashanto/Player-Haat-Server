/**
 * Builds prisma/seed/data/boundaries/{districts,upazilas}.json from OCHA/HDX "Bangladesh – Subnational Administrative
 * Boundaries" (COD-AB, BBS source, CC BY-IGO, admin levels 1-3; there is no union level). Run:
 *   npx tsx scripts/build-boundaries.ts <dir with bgd_admin2.geojson + bgd_admin3.geojson> [--report]
 *
 * Polygons are simplified (Douglas-Peucker ~60 m) and rounded to 4 decimals, and keyed by OUR names:
 *   districts: "<district>"            upazilas: "<district>|<upazila>"
 * The boundary data (2023) and our upazila list (bd-geo-info, newer in places) don't line up 1:1, so upazilas are matched
 * by normalised name inside the parent district, then by edit distance, then by prisma/seed/data/boundaries/overrides.json
 * ({"<district>|<our upazila>": "<boundary name or adm3 pcode>"}). Unmatched upazilas on either side are reported.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { districtsByDivision } from "../prisma/seed/data/districts.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: build-boundaries.ts <geojson dir>");
const OUT = new URL("../prisma/seed/data/boundaries/", import.meta.url);
const overrides: Record<string, string> = existsSync(new URL("overrides.json", OUT)) ? JSON.parse(readFileSync(new URL("overrides.json", OUT), "utf8")) : {};

type Ring = [number, number][];
type Geom = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
interface Feature { properties: Record<string, string | number | null>; geometry: Geom }

const norm = (s: string) => s.toLowerCase().replace(/\b(sadar|upazila|upazilla|thana|pt|ps|m\.?p\.?)\b/g, "").replace(/[^a-z]/g, "");
const ALIASES: Record<string, string> = { jhalakathi: "Jhalokati", barisal: "Barishal", comilla: "Cumilla", coxsbazar: "Cox's Bazar", bogra: "Bogura", chapainawabganj: "Chapai Nawabganj", chittagong: "Chattogram", netrokona: "Netrakona", jessore: "Jashore", maulvibazar: "Moulvibazar", nawabganj: "Chapai Nawabganj", chapainababganj: "Chapai Nawabganj", netrakona: "Netrokona" };
const ourDistricts = new Map<string, string>();
for (const list of Object.values(districtsByDivision)) for (const d of list) ourDistricts.set(norm(d.nameEn), d.nameEn);
const districtName = (n: string) => ourDistricts.get(norm(n)) ?? (ALIASES[norm(n)] ? ourDistricts.get(norm(ALIASES[norm(n)]!)) : undefined);

function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Douglas-Peucker on a ring, tolerance in degrees. */
function simplify(ring: Ring, tol: number): Ring {
  if (ring.length <= 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  const d2 = (p: number[], a: number[], b: number[]) => {
    let x = a[0]!, y = a[1]!, dx = b[0]! - x, dy = b[1]! - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0]! - x) * dx + (p[1]! - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]!; y = b[1]!; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    return (p[0]! - x) ** 2 + (p[1]! - y) ** 2;
  };
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = d2(ring[i]!, ring[s]!, ring[e]!); if (d > max) { max = d; idx = i; } }
    if (max > tol * tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as [number, number]);
  return out.length >= 4 ? out : ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as [number, number]);
}
const polys = (g: Geom): Ring[][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
const shrink = (g: Geom, tol = 0.0006) => polys(g).map((poly) => poly.map((r) => simplify(r, tol)));
const read = (f: string): Feature[] => (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { features: Feature[] }).features;

// ── districts ──
const districts: Record<string, Ring[][]> = {};
const districtUnmatched: string[] = [];
for (const f of read("bgd_admin2.geojson")) {
  const n = districtName(String(f.properties.adm2_name));
  if (!n) { districtUnmatched.push(String(f.properties.adm2_name)); continue; }
  districts[n] = shrink(f.geometry);
}

// ── upazilas ──
const full = JSON.parse(readFileSync(new URL("../prisma/seed/data/locations-full.json", import.meta.url), "utf8")) as Array<{ district: string; nameEn: string }>;
const byDistrict = new Map<string, Feature[]>();
for (const f of read("bgd_admin3.geojson")) {
  const dn = districtName(String(f.properties.adm2_name));
  if (!dn) continue;
  (byDistrict.get(dn) ?? byDistrict.set(dn, []).get(dn)!).push(f);
}
const upazilas: Record<string, Ring[][]> = {};
const used = new Set<Feature>();
const unmatchedOurs: string[] = [];
const how = { exact: 0, fuzzy: 0, override: 0 };
for (const u of full) {
  const key = `${u.district}|${u.nameEn}`;
  const pool = byDistrict.get(districtName(u.district) ?? u.district) ?? [];
  let hit: Feature | undefined;
  const ov = overrides[key];
  if (ov) { hit = pool.find((f) => f.properties.adm3_name === ov || f.properties.adm3_pcode === ov); if (hit) how.override++; }
  if (!hit) { hit = pool.find((f) => !used.has(f) && norm(String(f.properties.adm3_name)) === norm(u.nameEn)); if (hit) how.exact++; }
  if (!hit) {
    const cands = pool.filter((f) => !used.has(f)).map((f) => ({ f, d: lev(norm(String(f.properties.adm3_name)), norm(u.nameEn)) })).sort((a, b) => a.d - b.d);
    if (cands[0] && cands[0].d <= 2 && (!cands[1] || cands[1].d > cands[0].d)) { hit = cands[0].f; how.fuzzy++; }
  }
  if (!hit) { unmatchedOurs.push(key); continue; }
  used.add(hit);
  upazilas[key] = shrink(hit.geometry);
}
const unmatchedTheirs = [...byDistrict.values()].flat().filter((f) => !used.has(f)).map((f) => `${districtName(String(f.properties.adm2_name))}|${f.properties.adm3_name} (${f.properties.adm3_pcode})`);

writeFileSync(new URL("districts.json", OUT), JSON.stringify(districts));
writeFileSync(new URL("upazilas.json", OUT), JSON.stringify(upazilas));
const report = { districts: Object.keys(districts).length, districtUnmatched, upazilasMatched: Object.keys(upazilas).length, how, ourUpazilas: full.length, unmatchedOurs, unmatchedTheirs };
writeFileSync(new URL("match-report.json", OUT), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ ...report, unmatchedOurs: report.unmatchedOurs.length, unmatchedTheirs: report.unmatchedTheirs.length }, null, 1));
