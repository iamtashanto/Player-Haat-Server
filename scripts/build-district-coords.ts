/**
 * Writes prisma/seed/data/district-coords.json (district nameEn -> [lat, lng]) from the coordinates `bd-geo-info`
 * ships for its 64 districts. (The package has NO coordinates for upazilas or unions.) Run: npx tsx scripts/build-district-coords.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { districtsByDivision } from "../prisma/seed/data/districts.js";

const file = new URL("../node_modules/bd-geo-info/dist/esm/data/bd-districts.json", import.meta.url);
const src = JSON.parse(readFileSync(file, "utf8")) as { districts: Array<{ name: string; lat: string; long: string }> };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const ALIASES: Record<string, string> = { jhalakathi: "Jhalokati", barisal: "Barishal", comilla: "Cumilla", coxsbazar: "Cox's Bazar", bogra: "Bogura", chapainawabganj: "Chapai Nawabganj", chittagong: "Chattogram", netrokona: "Netrakona", jessore: "Jashore", maulvibazar: "Moulvibazar", nawabganj: "Chapai Nawabganj" };
const ours = new Map<string, string>();
for (const list of Object.values(districtsByDivision)) for (const d of list) ours.set(norm(d.nameEn), d.nameEn);

const out: Record<string, [number, number]> = {};
const unmatched: string[] = [];
for (const d of src.districts) {
  const key = norm(d.name);
  const name = ours.get(key) ?? (ALIASES[key] && ours.has(norm(ALIASES[key]!)) ? ALIASES[key] : undefined);
  const lat = Number(d.lat), lng = Number(d.long);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) { unmatched.push(d.name); continue; }
  out[name] = [lat, lng];
}
const missing = [...ours.values()].filter((n) => !out[n]);
writeFileSync(new URL("../prisma/seed/data/district-coords.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${Object.keys(out).length} districts; unmatched in package: ${unmatched.join(", ") || "none"}; ours without coordinates: ${missing.join(", ") || "none"}`);
