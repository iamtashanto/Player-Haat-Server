/**
 * EXPLAIN (ANALYZE, BUFFERS) for the hot queries against the bench database. The player-search and
 * matching cases run the EXACT SQL the app builds (buildSearchSql / buildMatchingSql); the rest are
 * hand-written equivalents of the Prisma-builder queries in the services.
 *
 *   DATABASE_URL=…/playerhaat_bench npx tsx scripts/loadtest/explain.ts [label]
 * Full plans are written to scripts/loadtest/plans-<label>.txt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/prisma.js";
import { buildSearchSql } from "../../src/modules/players/search.service.js";
import { buildMatchingSql } from "../../src/modules/requests/matching.service.js";

const label = process.argv[2] ?? "run";
const meta = JSON.parse(readFileSync(new URL("./.bench-meta.json", import.meta.url), "utf8")) as { hotUpazilas: number[]; footballId: number };
const hot = meta.hotUpazilas[0]!;
const hotDistrict = (await prisma.upazila.findUniqueOrThrow({ where: { id: hot } })).districtId;
const cold = (await prisma.upazila.findFirstOrThrow({ orderBy: { id: "desc" } })).id;
const F = meta.footballId;
const VIEWER = "bu1";
const ME = "bu777";
const q = (o: object) => ({ sort: "rating" as const, limit: 20, ...o });
const enc = (c: object) => Buffer.from(JSON.stringify(c)).toString("base64url");
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const cases: Array<[string, Prisma.Sql]> = [
  ["search: national, no filters, by rating", buildSearchSql(VIEWER, q({}))],
  ["search: hot upazila, football GK + khep", buildSearchSql(VIEWER, q({ upazilaId: hot, sportId: F, position: "GK", khepAvailable: true }))],
  ["search: cold upazila", buildSearchSql(VIEWER, q({ upazilaId: cold }))],
  ["search: district + minRating 4, by activity", buildSearchSql(VIEWER, q({ districtId: hotDistrict, minRating: 4, sort: "active" }))],
  ["search: sport + budget + Friday (national)", buildSearchSql(VIEWER, q({ sportId: F, rateMin: 300, rateMax: 500, availabilityDay: "fri" }))],
  ["search: national sport+GK, page 3 (rating cursor)", buildSearchSql(VIEWER, q({ sportId: F, position: "GK", cursor: enc({ s: "rating", v: [3.2, 20, "bp50000"] }) }))],
  ["search: hot upazila, page 2 (active cursor)", buildSearchSql(VIEWER, q({ upazilaId: hot, sort: "active", cursor: enc({ s: "active", v: [ago(30), "bp500"] }) }))],
  ["matching: paid GK request, hot upazila", buildMatchingSql({ createdById: VIEWER, sportId: F, positionsNeeded: ["GK"], isPaid: true, budgetMin: 300, budgetMax: 600, districtId: hotDistrict, upazilaId: hot, unionId: null })],
  ["matching: free any-position, cold upazila", buildMatchingSql({ createdById: VIEWER, sportId: F, positionsNeeded: [], isPaid: false, budgetMin: null, budgetMax: null, districtId: 1, upazilaId: cold, unionId: null })],
  ["feed: open upcoming in hot upazila", Prisma.sql`SELECT r.* FROM "PlayerRequest" r JOIN "User" u ON u.id = r."createdById" WHERE r.status = 'OPEN' AND NOT r."isHidden" AND r."matchAt" > now() AND r."createdById" <> ${VIEWER} AND u.status = 'ACTIVE' AND r."upazilaId" = ${hot} ORDER BY r."matchAt" ASC, r.id ASC LIMIT 21`],
  ["feed: open upcoming, national, football", Prisma.sql`SELECT r.* FROM "PlayerRequest" r JOIN "User" u ON u.id = r."createdById" WHERE r.status = 'OPEN' AND NOT r."isHidden" AND r."matchAt" > now() AND r."createdById" <> ${VIEWER} AND u.status = 'ACTIVE' AND r."sportId" = ${F} ORDER BY r."matchAt" ASC, r.id ASC LIMIT 21`],
  ["my requests", Prisma.sql`SELECT * FROM "PlayerRequest" WHERE "createdById" = ${ME} ORDER BY "createdAt" DESC, id DESC LIMIT 21`],
  ["my applications", Prisma.sql`SELECT * FROM "Application" WHERE "playerId" = ${ME} ORDER BY "createdAt" DESC, id DESC LIMIT 21`],
  ["applicants of a request", Prisma.sql`SELECT * FROM "Application" WHERE "requestId" = 'br100' ORDER BY "createdAt" ASC, id ASC LIMIT 21`],
  ["notifications inbox", Prisma.sql`SELECT * FROM "Notification" WHERE "userId" = ${ME} ORDER BY "createdAt" DESC, id DESC LIMIT 21`],
  ["notifications unread count", Prisma.sql`SELECT count(*) FROM "Notification" WHERE "userId" = ${ME} AND "readAt" IS NULL`],
  ["public reviews of a player", Prisma.sql`SELECT * FROM "Rating" WHERE "rateeId" = ${ME} AND direction = 'CAPTAIN_TO_PLAYER' AND NOT "noShow" ORDER BY "createdAt" DESC, id DESC LIMIT 21`],
  ["pending ratings (captain side)", Prisma.sql`SELECT * FROM "PlayerRequest" WHERE "createdById" = ${ME} AND status = 'COMPLETED' AND "completedAt" > ${ago(7)}::timestamp ORDER BY "completedAt" DESC LIMIT 50`],
  ["reminder job: followup candidates", Prisma.sql`SELECT r."createdById", r.id FROM "PlayerRequest" r JOIN "User" u ON u.id = r."createdById" AND u.status = 'ACTIVE' WHERE r.status = 'COMPLETED' AND r."completedAt" <= ${ago(3)}::timestamp AND r."completedAt" > ${ago(7)}::timestamp AND EXISTS (SELECT 1 FROM "Application" a WHERE a."requestId" = r.id AND a.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM "Rating" g WHERE g."requestId" = r.id AND g."raterId" = r."createdById" AND g."rateeId" = a."playerId")) AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."userId" = r."createdById" AND n.type = 'RATING_REMINDER' AND n.data->>'requestId' = r.id AND n.data->>'kind' = 'followup')`],
  ["expire-stale-requests: find", Prisma.sql`SELECT id FROM "PlayerRequest" WHERE status = 'OPEN' AND "playersAccepted" = 0 AND "matchAt" < ${ago(1)}::timestamp LIMIT 500`],
  ["purge: expired refresh tokens", Prisma.sql`SELECT id FROM "RefreshToken" WHERE "expiresAt" < ${ago(7)}::timestamp LIMIT 5000`],
  ["purge: old notifications", Prisma.sql`SELECT id FROM "Notification" WHERE "createdAt" < ${ago(180)}::timestamp LIMIT 5000`],
  ["location search 'kal'", Prisma.sql`SELECT id FROM "Union" WHERE "nameEn" ILIKE '%kal%' OR "nameBn" LIKE '%kal%' LIMIT 20`],
];

let out = "";
console.log(`\n${"query".padEnd(52)} ${"exec ms".padStart(8)}  plan highlights`);
for (const [name, sql] of cases) {
  const rows = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  out += `\n===== ${name} =====\n${plan}\n`;
  const exec = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? "?";
  const flags = [
    ...new Set([...plan.matchAll(/(Seq Scan on [\w"]+|Index (?:Only )?Scan using [\w"]+|Bitmap Index Scan on [\w"]+)/g)].map((m) => m[1]!.replace("Index Scan using ", "idx:").replace("Index Only Scan using ", "idx-only:").replace("Bitmap Index Scan on ", "bitmap:"))),
  ];
  const sort = /Sort Method: ([\w\- ]+)/.exec(plan)?.[1];
  console.log(`${name.padEnd(52)} ${exec.padStart(8)}  ${flags.join(", ")}${sort ? `  [sort: ${sort.trim()}]` : ""}`);
}
writeFileSync(new URL(`./plans-${label}.txt`, import.meta.url), out);
await prisma.$disconnect();
