/**
 * Writes bd-places.json into the bd-geo-info package, keyed by ITS district and upazila ids:
 *   npx tsx scripts/export-places-to-geo-package.ts /path/to/bd-geo-info/src/data
 * Reads prisma/seed/data/places.json (see build-places.ts). Places the package's lists cannot place (no matching upazila) go
 * under their district; ones with no matching district are reported and skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { districtsByDivision } from "../prisma/seed/data/districts.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: export-places-to-geo-package.ts <bd-geo-info/src/data>");
const rows = JSON.parse(readFileSync(new URL("../prisma/seed/data/places.json", import.meta.url), "utf8")) as [string, string, string, number, number, string, string][];
const pkgDistricts = (JSON.parse(readFileSync(`${dir}/bd-districts.json`, "utf8")) as { districts: { id: string; name: string }[] }).districts;
const pkgUpazilas = JSON.parse(readFileSync(`${dir}/bd-upazilas.json`, "utf8")) as Record<string, { id: string; name: string }[]>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const ALIASES: Record<string, string> = { jhalakathi: "Jhalokati", barisal: "Barishal", comilla: "Cumilla", coxsbazar: "Cox's Bazar", bogra: "Bogura", chapainawabganj: "Chapai Nawabganj", chittagong: "Chattogram", netrokona: "Netrakona", jessore: "Jashore", maulvibazar: "Moulvibazar", nawabganj: "Chapai Nawabganj" };
const ours = new Map<string, string>();
for (const list of Object.values(districtsByDivision)) for (const d of list) ours.set(norm(d.nameEn), d.nameEn);
const pkgIdByOurName = new Map<string, string>();
for (const d of pkgDistricts) {
  const n = ours.get(norm(d.name)) ?? (ALIASES[norm(d.name)] ? ours.get(norm(ALIASES[norm(d.name)]!)) : undefined);
  if (n) pkgIdByOurName.set(n, d.id);
}
const upazilaId = (districtId: string, name: string) => pkgUpazilas[districtId]?.find((u) => norm(u.name) === norm(name))?.id;

const byUpazila: Record<string, [string, string, string, number, number][]> = {};
const byDistrict: Record<string, [string, string, string, number, number][]> = {};
let skipped = 0;
for (const [name, bn, kind, lat, lng, district, upazila] of rows) {
  const d = pkgIdByOurName.get(district);
  if (!d) { skipped++; continue; }
  const u = upazila ? upazilaId(d, upazila) : undefined;
  const bucket = u ? (byUpazila[u] ??= []) : (byDistrict[d] ??= []);
  bucket.push([name, bn, kind, lat, lng]);
}
writeFileSync(`${dir}/bd-places.json`, JSON.stringify({
  attribution: "Place names and positions: GeoNames (https://www.geonames.org), CC BY 4.0, plus a hand-checked list of well-known places with Bangla names.",
  kinds: ["VILLAGE", "TOWN", "MARKET", "ISLAND", "BEACH", "AREA"],
  columns: ["name", "bn_name", "kind", "lat", "long"],
  byUpazila,
  byDistrict,
}));
const inUpazila = Object.values(byUpazila).reduce((n, l) => n + l.length, 0);
const inDistrict = Object.values(byDistrict).reduce((n, l) => n + l.length, 0);
console.log(`${inUpazila} places under ${Object.keys(byUpazila).length} upazilas, ${inDistrict} under districts only, ${skipped} skipped`);
