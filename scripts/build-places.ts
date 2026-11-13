/**
 * Builds prisma/seed/data/places.json: villages, towns, markets (bazaars), islands, beaches and well-known areas, so people can
 * search "Kuakata" or their own village and land on the right upazila.
 *   npx tsx scripts/build-places.ts /path/to/BD.txt        (GeoNames, https://download.geonames.org/export/dump/BD.zip)
 * Source: GeoNames (CC BY 4.0: credit "GeoNames" where the data is shown, see docs/BOUNDARY_DATA.md) plus prisma/seed/data/places-extra.json
 * (hand-checked well-known places with Bangla names). Each place is assigned to its district and upazila by the boundary polygons;
 * a place outside every polygon is dropped. Row format: [nameEn, nameBn, kind, lat, lng, district, upazila].
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { locate } from "../src/modules/locations/boundaries.js";

const src = process.argv[2];
if (!src) throw new Error("usage: build-places.ts <BD.txt>");
const OUT = new URL("../prisma/seed/data/places.json", import.meta.url);
const BN = /[ঀ-৿]/;

const KIND: Record<string, string> = { "P.PPL": "VILLAGE", "P.PPLX": "VILLAGE", "P.PPLA": "TOWN", "P.PPLA2": "TOWN", "P.PPLA3": "TOWN", "P.PPLA4": "TOWN", "P.PPLC": "TOWN", "P.PPLL": "VILLAGE", "S.MKT": "MARKET", "T.ISL": "ISLAND", "T.BCH": "BEACH", "L.LCTY": "AREA", "L.AREA": "AREA", "L.RESF": "AREA" };

type Row = [string, string, string, number, number, string, string];
const rows: Row[] = [];
const seen = new Set<string>();
let dropped = 0;
const add = (name: string, bn: string, kind: string, lat: number, lng: number) => {
  const at = locate(lat, lng);
  if (!at) { dropped++; return; }
  const key = `${name.toLowerCase()}|${at.district}|${at.upazila ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push([name, bn, kind, Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, at.district, at.upazila ?? ""]);
};

for (const line of readFileSync(src, "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 8) continue;
  const kind = KIND[`${f[6]}.${f[7]}`];
  if (!kind) continue;
  const name = (f[2] || f[1] || "").trim();
  if (name.length < 3 || /^\d/.test(name)) continue;
  const bn = f[3]!.split(",").find((a) => BN.test(a))?.trim() ?? "";
  add(name, bn, kind, Number(f[4]), Number(f[5]));
}
const geonames = rows.length;
const extraUrl = new URL("../prisma/seed/data/places-extra.json", import.meta.url);
const extraRows: [string, string, string, number, number][] = existsSync(extraUrl)
  ? (JSON.parse(readFileSync(extraUrl, "utf8")) as [string, string, string, number, number][])
  : [];
for (const [name, bn, kind, lat, lng] of extraRows) {
  // the hand-checked entry replaces a GeoNames one of the same name (so its Bangla name wins)
  const i = rows.findIndex((r) => r[0].toLowerCase() === name.toLowerCase());
  const at = locate(lat, lng);
  if (i >= 0 && at && rows[i]![5] === at.district) { rows[i]![1] = bn; rows[i]![2] = kind; continue; }
  add(name, bn, kind, lat, lng);
}
rows.sort((a, b) => a[5].localeCompare(b[5]) || a[6].localeCompare(b[6]) || a[0].localeCompare(b[0]));
writeFileSync(OUT, JSON.stringify(rows));
const noUpazila = rows.filter((r) => !r[6]).length;
console.log(`${rows.length} places (${geonames} from GeoNames, ${rows.length - geonames} extra), ${noUpazila} with district only, ${dropped} dropped outside Bangladesh polygons`);
const k = rows.filter((r) => /kuakata/i.test(r[0]));
console.log(k.map((r) => r.join(" | ")).join("\n"));
