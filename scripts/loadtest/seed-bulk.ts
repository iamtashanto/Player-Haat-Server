/**
 * Fills a THROWAWAY database with a realistic national-scale dataset so query plans and the load test
 * mean something: ~100k users/profiles (30% of them clustered in 10 hot upazilas, like real cities),
 * ~150k sport entries, 60k requests, ~170k applications, ratings, 300k notifications, 200k sessions.
 *
 *   createdb playerhaat_bench && DATABASE_URL=postgresql://localhost/playerhaat_bench npx prisma migrate deploy
 *   DATABASE_URL=… npm run db:seed            # locations + sports first
 *   DATABASE_URL=… npx tsx scripts/loadtest/seed-bulk.ts [users=100000]
 *
 * Refuses to run unless the database name ends in `_bench`.
 */
import { hash } from "@node-rs/argon2";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const url = process.env.DATABASE_URL ?? "";
const dbName = new URL(url).pathname.replace(/^\//, "");
if (!dbName.endsWith("_bench")) {
  console.error(`Refusing to bulk-load "${dbName}": the database name must end with "_bench".`);
  process.exit(1);
}

const N = Number(process.argv[2] ?? 100_000);
const REQUESTS = Math.round(N * 0.6);
const prisma = new PrismaClient();
const t0 = Date.now();
const step = async (label: string, sql: string) => {
  const s = Date.now();
  const n = await prisma.$executeRawUnsafe(sql);
  console.log(`${label.padEnd(26)} ${String(n).padStart(8)} rows  ${((Date.now() - s) / 1000).toFixed(1)}s`);
};

async function main() {
  if ((await prisma.upazila.count()) < 100) throw new Error("Seed locations first: npm run db:seed");
  const football = (await prisma.sport.findUniqueOrThrow({ where: { code: "FOOTBALL" } })).id;
  const cricket = (await prisma.sport.findUniqueOrThrow({ where: { code: "CRICKET" } })).id;
  await prisma.$executeRawUnsafe(`TRUNCATE "User" RESTART IDENTITY CASCADE`);

  // Location sampling table: the 10 lowest-id upazilas appear 40× more often than the rest.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS bench_geo`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE bench_geo AS
    SELECT row_number() OVER () AS n, x.id AS "upazilaId", x."districtId"
    FROM (SELECT id, "districtId", CASE WHEN id < (SELECT min(id) + 10 FROM "Upazila") THEN 40 ELSE 1 END AS w FROM "Upazila") x
    CROSS JOIN LATERAL generate_series(1, x.w)`);
  const geoN = Number((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM bench_geo`))[0]!.c);

  await step("users", `
    INSERT INTO "User"(id, name, email, locale, status, "createdAt", "updatedAt")
    SELECT 'bu'||i, 'Bench Player '||i, 'bench'||i||'@bench.test',
           CASE WHEN random() < 0.85 THEN 'bn'::"Locale" ELSE 'en'::"Locale" END,
           CASE WHEN random() < 0.01 THEN 'SUSPENDED'::"UserStatus" ELSE 'ACTIVE'::"UserStatus" END,
           now() - random() * interval '400 days', now()
    FROM generate_series(1, ${N}) i`);

  await step("player profiles (90%)", `
    INSERT INTO "PlayerProfile"(id, "userId", "districtId", "upazilaId", "unionId", "isVisible", "hiddenByAdminAt",
                                "avgRating", "ratingCount", "noShowCount", "lastActiveAt", "createdAt", "updatedAt")
    SELECT 'bp'||x.i, 'bu'||x.i, g."districtId", g."upazilaId",
           CASE WHEN x.r3 < 0.6 THEN (SELECT un.id FROM "Union" un WHERE un."upazilaId" = g."upazilaId" ORDER BY random() LIMIT 1) END,
           x.r4 > 0.05,
           CASE WHEN x.r4 < 0.005 THEN now() END,
           CASE WHEN x.r1 < 0.4 THEN 0 ELSE round((2 + x.r2 * 3)::numeric, 2) END,
           CASE WHEN x.r1 < 0.4 THEN 0 ELSE 1 + floor(x.r2 * 60)::int END,
           CASE WHEN x.r1 > 0.95 THEN floor(random() * 4)::int ELSE 0 END,
           now() - random() * interval '90 days', now() - random() * interval '400 days', now()
    FROM (SELECT i, random() r1, random() r2, random() r3, random() r4, 1 + floor(random() * ${geoN})::int gn
          FROM generate_series(1, ${Math.round(N * 0.9)}) i) x
    JOIN bench_geo g ON g.n = x.gn`);

  const sportInsert = (prefix: string, where: string, sportExpr: string) => `
    INSERT INTO "PlayerSport"(id, "profileId", "sportId", positions, "skillLevel", "khepAvailable", "rateMin", "rateMax",
                              availability, "travelRadius", "createdAt", "updatedAt")
    SELECT '${prefix}'||x.i, 'bp'||x.i, ${sportExpr},
           ARRAY[(SELECT code FROM "Position" WHERE "sportId" = ${sportExpr} ORDER BY random() LIMIT 1)],
           1 + floor(random() * 5)::int, x.khep,
           CASE WHEN x.khep AND x.r2 < 0.7 THEN 200 + floor(x.r3 * 4)::int * 50 END,
           CASE WHEN x.khep AND x.r2 < 0.7 THEN 450 + floor(x.r3 * 8)::int * 50 END,
           CASE WHEN x.r4 < 0.7 THEN jsonb_build_object('fri', jsonb_build_array('evening'), 'sat', jsonb_build_array('morning', 'afternoon'))
                WHEN x.r4 < 0.85 THEN jsonb_build_object('mon', jsonb_build_array('evening'), 'wed', jsonb_build_array('evening')) END,
           (CASE WHEN x.r5 < 0.15 THEN 'UNION' WHEN x.r5 < 0.75 THEN 'UPAZILA' ELSE 'DISTRICT' END)::"TravelRadius",
           now(), now()
    FROM (SELECT i, random() r1, random() < 0.4 AS khep, random() r2, random() r3, random() r4, random() r5
          FROM generate_series(1, ${Math.round(N * 0.9)}) i) x
    WHERE ${where}`;
  await step("sport #1 (all profiles)", sportInsert("bs1", "true", `(CASE WHEN x.i % 10 < 7 THEN ${football} ELSE ${cricket} END)`));
  await step("sport #2 (30%)", sportInsert("bs2", "x.r4 > 0.7", `(CASE WHEN x.i % 10 < 7 THEN ${cricket} ELSE ${football} END)`));

  await step("requests", `
    INSERT INTO "PlayerRequest"(id, "createdById", "sportId", "matchAt", "venueText", "districtId", "upazilaId", "unionId",
                                "positionsNeeded", "playersNeeded", "isPaid", "budgetMin", "budgetMax", status, "completedAt", "createdAt", "updatedAt")
    SELECT 'br'||x.i, 'bu'||(1 + floor(random() * ${N}))::int, x.sid,
           CASE WHEN x.st IN ('OPEN','FILLED') AND x.r2 < 0.8 THEN now() + random() * interval '14 days' ELSE now() - random() * interval '300 days' END,
           'Ground '||x.i, g."districtId", g."upazilaId", NULL,
           CASE WHEN x.r3 < 0.3 THEN ARRAY[]::text[] ELSE ARRAY[(SELECT code FROM "Position" WHERE "sportId" = x.sid ORDER BY random() LIMIT 1)] END,
           1 + floor(random() * 10)::int, x.paid, CASE WHEN x.paid THEN 300 END, CASE WHEN x.paid THEN 600 END,
           x.st::"RequestStatus", CASE WHEN x.st = 'COMPLETED' THEN now() - random() * interval '290 days' END,
           now() - random() * interval '300 days', now()
    FROM (SELECT i, random() r2, random() r3, random() < 0.4 AS paid,
                 CASE WHEN random() < 0.7 THEN ${football} ELSE ${cricket} END AS sid,
                 (ARRAY['OPEN','OPEN','FILLED','COMPLETED','COMPLETED','COMPLETED','CANCELLED'])[1 + floor(random() * 7)::int] AS st,
                 1 + floor(random() * ${geoN})::int gn
          FROM generate_series(1, ${REQUESTS}) i) x
    JOIN bench_geo g ON g.n = x.gn`);

  await step("applications", `
    INSERT INTO "Application"(id, "requestId", "playerId", status, "createdAt", "updatedAt")
    SELECT 'ba'||r.id||'_'||k, r.id, 'bu'||(1 + floor(random() * ${N}))::int,
           (CASE WHEN r.status = 'COMPLETED' THEN (ARRAY['ACCEPTED','ACCEPTED','REJECTED'])[1 + floor(random() * 3)::int]
                 WHEN r.status = 'OPEN' THEN (ARRAY['PENDING','PENDING','PENDING','WITHDRAWN'])[1 + floor(random() * 4)::int]
                 WHEN r.status = 'FILLED' THEN (ARRAY['ACCEPTED','REJECTED','PENDING'])[1 + floor(random() * 3)::int]
                 ELSE 'REJECTED' END)::"ApplicationStatus",
           r."createdAt" + random() * interval '2 days', now()
    FROM "PlayerRequest" r CROSS JOIN generate_series(1, 3) k
    WHERE random() < 0.95
    ON CONFLICT DO NOTHING`);
  await step("playersAccepted counts", `
    UPDATE "PlayerRequest" r SET "playersAccepted" = LEAST(r."playersNeeded", c.n)
    FROM (SELECT "requestId", count(*)::int n FROM "Application" WHERE status = 'ACCEPTED' GROUP BY 1) c WHERE c."requestId" = r.id`);

  await step("ratings", `
    INSERT INTO "Rating"(id, "requestId", "raterId", "rateeId", direction, scores, overall, "createdAt")
    SELECT 'brt'||a.id, a."requestId", r."createdById", a."playerId", 'CAPTAIN_TO_PLAYER'::"RatingDirection", '{}'::jsonb, 1 + random() * 4, now() - random() * interval '60 days'
    FROM "Application" a JOIN "PlayerRequest" r ON r.id = a."requestId"
    WHERE a.status = 'ACCEPTED' AND r.status = 'COMPLETED' AND a."playerId" <> r."createdById"
    ON CONFLICT DO NOTHING`);

  await step("notifications", `
    INSERT INTO "Notification"(id, "userId", type, data, "readAt", "createdAt")
    SELECT 'bn'||i, 'bu'||(1 + floor(random() * ${N}))::int,
           (ARRAY['NEW_MATCHING_REQUEST','NEW_APPLICANT','APPLICATION_ACCEPTED','APPLICATION_REJECTED','RATING_REMINDER'])[1 + floor(random() * 5)::int]::"NotificationType",
           jsonb_build_object('requestId', 'br'||(1 + floor(random() * ${REQUESTS}))::int), CASE WHEN random() < 0.5 THEN now() END, now() - random() * interval '200 days'
    FROM generate_series(1, ${N * 3}) i`);
  await step("refresh tokens", `
    INSERT INTO "RefreshToken"(id, "userId", "tokenHash", "familyId", "expiresAt", "revokedAt", "createdAt")
    SELECT 'bt'||i, 'bu'||(1 + floor(random() * ${N}))::int, 'bth'||i, 'f'||(i % 90000), now() + (random() * 70 - 40) * interval '1 day', CASE WHEN random() < 0.3 THEN now() END, now() - random() * interval '60 days'
    FROM generate_series(1, ${N * 2}) i`);
  await step("verification codes", `
    INSERT INTO "VerificationCode"(id, type, target, "codeHash", "expiresAt", "createdAt")
    SELECT 'bv'||i, 'EMAIL_VERIFY', 'bench'||i||'@bench.test', 'h', now() + (random() * 6 - 5) * interval '1 day', now() - random() * interval '30 days'
    FROM generate_series(1, ${Math.round(N / 2)}) i`);

  // 20 real, loginable users for the load test (same password; argon2 with production parameters).
  const passwordHash = await hash("LoadTest123", { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const hot = (await prisma.$queryRawUnsafe<{ id: number; districtId: number }[]>(`SELECT id, "districtId" FROM "Upazila" ORDER BY id LIMIT 10`));
  for (let i = 1; i <= 20; i++) {
    const u = await prisma.user.create({ data: { name: `Load Tester ${i}`, email: `loadtest${i}@bench.test`, emailVerifiedAt: new Date(), passwordHash, authAccounts: { create: { provider: "EMAIL", providerUserId: `loadtest${i}@bench.test` } } } });
    await prisma.playerProfile.create({ data: { userId: u.id, districtId: hot[i % 10]!.districtId, upazilaId: hot[i % 10]!.id, sports: { create: [{ sportId: football, positions: ["GK"], skillLevel: 3 }] } } });
  }
  writeFileSync(new URL("./.bench-meta.json", import.meta.url), JSON.stringify({ hotUpazilas: hot.map((h) => h.id), hotDistricts: [...new Set(hot.map((h) => h.districtId))], footballId: football, cricketId: cricket }));

  await prisma.$executeRawUnsafe(`ANALYZE`);
  const counts = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(
    `SELECT 'User' t, count(*) n FROM "User" UNION ALL SELECT 'PlayerProfile', count(*) FROM "PlayerProfile" UNION ALL SELECT 'PlayerSport', count(*) FROM "PlayerSport"
     UNION ALL SELECT 'PlayerRequest', count(*) FROM "PlayerRequest" UNION ALL SELECT 'Application', count(*) FROM "Application" UNION ALL SELECT 'Rating', count(*) FROM "Rating"
     UNION ALL SELECT 'Notification', count(*) FROM "Notification" UNION ALL SELECT 'RefreshToken', count(*) FROM "RefreshToken"`);
  console.log("\n" + counts.map((c) => `${c.t.padEnd(14)} ${String(c.n).padStart(9)}`).join("\n"));
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s — load-test users: loadtest1..20@bench.test / LoadTest123`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
