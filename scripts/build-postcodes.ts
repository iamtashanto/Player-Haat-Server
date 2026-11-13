/**
 * Builds prisma/seed/data/postcodes.json from bd-geo-info's bd-postcodes.json (BBS post-office directory):
 *   npx tsx scripts/build-postcodes.ts /path/to/bd-geo-info/src/data
 * Entries are keyed by OUR names: "<district>|<upazila>" → [{ office, code }]. Matching is by normalised name inside the
 * parent district; anything unmatched is listed and skipped (it is never guessed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { districtsByDivision } from "../prisma/seed/data/districts.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: build-postcodes.ts <bd-geo-info/src/data>");
const OUT = new URL("../prisma/seed/data/postcodes.json", import.meta.url);
const full = JSON.parse(readFileSync(new URL("../prisma/seed/data/locations-full.json", import.meta.url), "utf8")) as { district: string; nameEn: string }[];
const pkgDistricts = (JSON.parse(readFileSync(`${dir}/bd-districts.json`, "utf8")) as { districts: { id: string; name: string }[] }).districts;
const postcodes = (JSON.parse(readFileSync(`${dir}/bd-postcodes.json`, "utf8")) as { postcodes: { district_id: string; upazila: string; postOffice: string; postCode: string }[] }).postcodes;

const norm = (s: string) => s.toLowerCase().replace(/\b(sadar|upazila|upazilla|thana|pt|ps|s\.?o\.?|p\.?o\.?)\b/g, "").replace(/[^a-z]/g, "");
const ALIASES: Record<string, string> = { jhalakathi: "Jhalokati", barisal: "Barishal", comilla: "Cumilla", coxsbazar: "Cox's Bazar", bogra: "Bogura", chapainawabganj: "Chapai Nawabganj", chittagong: "Chattogram", netrokona: "Netrakona", jessore: "Jashore", maulvibazar: "Moulvibazar", nawabganj: "Chapai Nawabganj" };
const ourDistricts = new Map<string, string>();
for (const list of Object.values(districtsByDivision)) for (const d of list) ourDistricts.set(norm(d.nameEn), d.nameEn);
const ourDistrict = (n: string) => ourDistricts.get(norm(n)) ?? (ALIASES[norm(n)] ? ourDistricts.get(norm(ALIASES[norm(n)]!)) : undefined);
const pkgName = new Map(pkgDistricts.map((d) => [d.id, d.name]));

function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

const upazilasOf = new Map<string, string[]>();
for (const u of full) upazilasOf.set(u.district, [...(upazilasOf.get(u.district) ?? []), u.nameEn]);

const out: Record<string, { office: string; code: string }[]> = {};
const unmatched: string[] = [];
for (const p of postcodes) {
  const d = ourDistrict(pkgName.get(p.district_id) ?? "");
  const list = d ? (upazilasOf.get(d) ?? []) : [];
  const want = norm(p.upazila);
  const hit = list.find((n) => norm(n) === want) ?? list.find((n) => norm(n).startsWith(want) || want.startsWith(norm(n))) ?? list.find((n) => want.length >= 4 && (norm(n).includes(want) || want.includes(norm(n))));
  const close = hit ?? (want.length >= 6 ? [...list].map((n) => ({ n, d: lev(norm(n), want) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d)[0]?.n : undefined);
  if (!d || !close) {
    unmatched.push(`${pkgName.get(p.district_id)}|${p.upazila}|${p.postOffice}|${p.postCode}`);
    continue;
  }
  const key = `${d}|${close}`;
  (out[key] ??= []).push({ office: p.postOffice.replace(/--.*$/, "").trim(), code: p.postCode });
}
for (const k of Object.keys(out)) {
  const seen = new Set<string>();
  out[k] = out[k]!.filter((x) => (seen.has(x.code + x.office) ? false : (seen.add(x.code + x.office), true))).sort((a, b) => a.code.localeCompare(b.code));
}
writeFileSync(OUT, JSON.stringify(out));
const matched = Object.values(out).reduce((n, l) => n + l.length, 0);
console.log(`matched ${matched} of ${postcodes.length} post offices into ${Object.keys(out).length} upazilas; ${unmatched.length} unmatched`);
if (unmatched.length) console.log(unmatched.slice(0, 25).join("\n"));
