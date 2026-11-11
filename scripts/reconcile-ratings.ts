/**
 * Aligns existing data with the rating rules, then recomputes every aggregate from scratch.
 *   - Application.attendance = NO_SHOW is the single source of strikes: a missing mirror row is created, and a
 *     no-show row whose application is now ATTENDED (or gone) is removed.
 *   - reliability / noShowCount / averages / the damped (Bayesian) average are recomputed from the rows.
 *
 *   npx tsx scripts/reconcile-ratings.ts --dry-run   # report only
 *   npx tsx scripts/reconcile-ratings.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { recomputeEverything } from "../src/modules/ratings/ratings.service.js";

const dry = process.argv.includes("--dry-run");

const missing = await prisma.$queryRaw<{ requestId: string; playerId: string; captainId: string }[]>`
  SELECT a."requestId", a."playerId", q."createdById" AS "captainId" FROM "Application" a JOIN "PlayerRequest" q ON q.id = a."requestId"
  WHERE a.attendance = 'NO_SHOW'
    AND NOT EXISTS (SELECT 1 FROM "Rating" r WHERE r."requestId" = a."requestId" AND r."rateeId" = a."playerId" AND r."raterId" = q."createdById")`;
const stale = await prisma.$queryRaw<{ id: string }[]>`
  SELECT r.id FROM "Rating" r
  WHERE r."noShow" AND NOT EXISTS (SELECT 1 FROM "Application" a WHERE a."requestId" = r."requestId" AND a."playerId" = r."rateeId" AND a.attendance = 'NO_SHOW')`;
const people = await prisma.user.count({ where: { OR: [{ playerProfile: { isNot: null } }, { ratingsReceived: { some: {} } }] } });
console.log(JSON.stringify({ dryRun: dry, strikesToCreate: missing.length, strikesToRemove: stale.length, peopleToRecompute: people }));

if (!dry) {
  const now = new Date();
  for (const m of missing) {
    await prisma.rating.create({ data: { requestId: m.requestId, raterId: m.captainId, rateeId: m.playerId, direction: "CAPTAIN_TO_PLAYER", scores: {}, overall: 1, noShow: true, revealedAt: now } });
  }
  if (stale.length) await prisma.rating.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  const ids = await prisma.user.findMany({ where: { OR: [{ playerProfile: { isNot: null } }, { ratingsReceived: { some: {} } }] }, select: { id: true } });
  for (const { id } of ids) await prisma.$transaction((tx) => recomputeEverything(tx, id));
  console.log("done");
}
await prisma.$disconnect();
