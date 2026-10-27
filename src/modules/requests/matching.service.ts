import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notify, runInBackground } from "../notifications/notifier.js";

/** Upper bound on how many players one new request can notify (spam and FCM cost control). */
export const MAX_FANOUT = 200;

export interface Needs {
  createdById: string;
  sportId: number;
  positionsNeeded: string[];
  isPaid: boolean;
  budgetMin: number | null;
  budgetMax: number | null;
  districtId: number;
  upazilaId: number;
  unionId: number | null;
}

/**
 * Players who should hear about a new request. All must hold on ONE of the player's sport entries:
 *  - same sport; position overlaps (a request with no positions is open to any)
 *  - paid request  → player is khepAvailable and their rate range overlaps the budget ("negotiable" matches)
 *    free request  → any player of that sport (khep or not)
 *  - within the player's travel radius: UNION = same union, UPAZILA = same upazila, DISTRICT = same district
 * and the player is visible, active, not admin-hidden, and not the poster. Best-rated and most active first.
 */
export function buildMatchingSql(r: Needs, limit = MAX_FANOUT): Prisma.Sql {
  const sport: Prisma.Sql[] = [
    Prisma.sql`ps."sportId" = ${r.sportId}`,
    Prisma.sql`(cardinality(${r.positionsNeeded}::text[]) = 0 OR ps.positions && ${r.positionsNeeded}::text[])`,
  ];
  if (r.isPaid) {
    sport.push(Prisma.sql`ps."khepAvailable" = true`);
    if (r.budgetMax !== null) sport.push(Prisma.sql`(ps."rateMin" IS NULL OR ps."rateMin" <= ${r.budgetMax})`);
    if (r.budgetMin !== null) sport.push(Prisma.sql`(ps."rateMax" IS NULL OR ps."rateMax" >= ${r.budgetMin})`);
  }
  const radius: Prisma.Sql[] = [
    Prisma.sql`(ps."travelRadius" = 'DISTRICT' AND p."districtId" = ${r.districtId})`,
    Prisma.sql`(ps."travelRadius" = 'UPAZILA' AND p."upazilaId" = ${r.upazilaId})`,
  ];
  if (r.unionId !== null) radius.push(Prisma.sql`(ps."travelRadius" = 'UNION' AND p."unionId" = ${r.unionId})`);
  sport.push(Prisma.sql`(${Prisma.join(radius, " OR ")})`);

  return Prisma.sql`
    SELECT p."userId"
    FROM "PlayerProfile" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p."isVisible" = true
      AND p."hiddenByAdminAt" IS NULL
      AND u.status = 'ACTIVE'
      AND p."userId" <> ${r.createdById}
      AND EXISTS (SELECT 1 FROM "PlayerSport" ps WHERE ps."profileId" = p.id AND ${Prisma.join(sport, " AND ")})
    ORDER BY p."avgRating" DESC, p."lastActiveAt" DESC, p.id ASC
    LIMIT ${limit}`;
}

export async function findMatchingPlayerIds(r: Needs, limit = MAX_FANOUT): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ userId: string }[]>(buildMatchingSql(r, limit));
  return rows.map((x) => x.userId);
}

/** After a request is created: push "new match near you" to everyone it fits. Runs in the background. */
export function announceNewRequest(requestId: string) {
  runInBackground("announce-request", async () => {
    const r = await prisma.playerRequest.findUnique({
      where: { id: requestId },
      include: { sport: { select: { nameBn: true, nameEn: true } } },
    });
    if (!r || r.status !== "OPEN" || r.isHidden) return;
    notify({
      userIds: await findMatchingPlayerIds(r),
      type: "NEW_MATCHING_REQUEST",
      data: { requestId: r.id },
      params: { sport: { bn: r.sport.nameBn, en: r.sport.nameEn }, venue: r.venueText, when: r.matchAt },
    });
  });
}
