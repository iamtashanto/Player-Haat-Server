/**
 * Builds prisma/seed/data/locations-full.json (every upazila/thana and union, English + Bangla) from the
 * `bd-geo-info` package (BBS-derived). Run after bumping the package: `pnpm tsx scripts/build-locations.ts`,
 * then `npm run db:seed`. District spellings are aligned to prisma/seed/data/districts.ts; an unmatched district fails the build.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDistricts, getDivisions, getUnions, getUpazilas } from "bd-geo-info";
import { districtsByDivision } from "../prisma/seed/data/districts.js";

const OUT = fileURLToPath(new URL("../prisma/seed/data/locations-full.json", import.meta.url));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
/** Package spelling → our spelling, where the normalised names differ. */
const ALIASES: Record<string, string> = {
  jhalakathi: "Jhalokati",
  barisal: "Barishal",
  comilla: "Cumilla",
  coxsbazar: "Cox's Bazar",
  bogra: "Bogura",
  chapainawabganj: "Chapai Nawabganj",
  chittagong: "Chattogram",
  netrokona: "Netrakona",
  jessore: "Jashore",
  maulvibazar: "Moulvibazar",
  nawabganj: "Chapai Nawabganj",
  brahmanbaria: "Brahmanbaria",
};
const ours = new Map<string, string>();
for (const list of Object.values(districtsByDivision)) for (const d of list) ours.set(norm(d.nameEn), d.nameEn);

interface Upazila {
  district: string;
  nameEn: string;
  nameBn: string;
  unions: Array<{ nameEn: string; nameBn: string }>;
}

const out: Upazila[] = [];
const unmatched: string[] = [];
const seenDistricts = new Set<string>();

for (const division of await getDivisions("en")) {
  for (const d of await getDistricts(division.value, "en")) {
    const key = norm(d.label);
    const name = ours.get(key) ?? (ALIASES[key] && ours.has(norm(ALIASES[key])) ? ALIASES[key] : undefined);
    if (!name) {
      unmatched.push(d.label);
      continue;
    }
    seenDistricts.add(name);
    const upazilasEn = await getUpazilas(d.value, "en");
    for (const u of upazilasEn) {
      const unionsEn = await getUnions(u.value, "en");
      const unionsBn = await getUnions(u.value, "bn");
      const bnById = new Map(unionsBn.map((x) => [x.value, x.label]));
      out.push({
        district: name,
        nameEn: u.name,
        nameBn: u.bn_name,
        unions: unionsEn.map((x) => ({ nameEn: x.label, nameBn: bnById.get(x.value) ?? x.label })),
      });
    }
  }
}

const missing = [...ours.values()].filter((n) => !seenDistricts.has(n));
if (unmatched.length || missing.length) {
  console.error({ unmatchedInPackage: unmatched, notFoundInPackage: missing });
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length} upazilas/thanas, ${out.reduce((n, u) => n + u.unions.length, 0)} unions`);
