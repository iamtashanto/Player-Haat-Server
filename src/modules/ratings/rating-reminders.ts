import type { Prisma } from "@prisma/client";
import { paramsToData } from "../../i18n/push-templates.js";
import { prisma } from "../../lib/prisma.js";
import { pushOnly } from "../notifications/notifier.js";
import { RATING_WINDOW_DAYS, REMINDER_AFTER_DAYS } from "./ratings.schema.js";

const DAY = 86_400_000;
type Pair = { userId: string; requestId: string };

/**
 * Second nudge for people who still haven't rated, once a match has been completed for
 * REMINDER_AFTER_DAYS and while the window is still open. (The first nudge goes out the moment the
 * match is completed — see completeRequest.) Each person gets it at most once per match.
 *
 * Safe to run on several instances at once: a transaction-scoped Postgres advisory lock lets one run
 * at a time, and the inbox rows (which are the "already reminded" marker) are written inside that lock.
 * Returns how many reminders were sent.
 */
export async function sendFollowupRatingReminders(now = new Date()): Promise<number> {
  // `timestamp` columns hold UTC; bind UTC text, not Dates, so a non-UTC DB session can't skew the bounds.
  const before = new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY).toISOString();
  const windowStart = new Date(now.getTime() - RATING_WINDOW_DAYS * DAY).toISOString();

  const sent = await prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('rating-reminders')) AS locked`;
      if (!lock[0]?.locked) return null;

      const pairs = await tx.$queryRaw<Pair[]>`
        SELECT a."playerId" AS "userId", r.id AS "requestId"
        FROM "Application" a
        JOIN "PlayerRequest" r ON r.id = a."requestId"
        JOIN "User" u ON u.id = a."playerId" AND u.status = 'ACTIVE'
        WHERE a.status = 'ACCEPTED' AND r.status = 'COMPLETED'
          AND r."completedAt" <= ${before}::timestamp AND r."completedAt" > ${windowStart}::timestamp
          AND NOT EXISTS (SELECT 1 FROM "Rating" g WHERE g."requestId" = r.id AND g."raterId" = a."playerId")
          AND NOT EXISTS (SELECT 1 FROM "Rating" g WHERE g."requestId" = r.id AND g."rateeId" = a."playerId" AND g."noShow")
          AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."userId" = a."playerId" AND n.type = 'RATING_REMINDER'
                          AND n.data->>'requestId' = r.id AND n.data->>'kind' = 'followup')
        UNION
        SELECT r."createdById" AS "userId", r.id AS "requestId"
        FROM "PlayerRequest" r
        JOIN "User" u ON u.id = r."createdById" AND u.status = 'ACTIVE'
        WHERE r.status = 'COMPLETED'
          AND r."completedAt" <= ${before}::timestamp AND r."completedAt" > ${windowStart}::timestamp
          AND EXISTS (SELECT 1 FROM "Application" a WHERE a."requestId" = r.id AND a.status = 'ACCEPTED'
                      AND NOT EXISTS (SELECT 1 FROM "Rating" g WHERE g."requestId" = r.id AND g."raterId" = r."createdById" AND g."rateeId" = a."playerId"))
          AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."userId" = r."createdById" AND n.type = 'RATING_REMINDER'
                          AND n.data->>'requestId' = r.id AND n.data->>'kind' = 'followup')`;
      if (pairs.length === 0) return [];

      const requests = await tx.playerRequest.findMany({
        where: { id: { in: [...new Set(pairs.map((p) => p.requestId))] } },
        select: { id: true, venueText: true, matchAt: true, sport: { select: { nameBn: true, nameEn: true } } },
      });
      const info = new Map(requests.map((r) => [r.id, r]));

      const rows = pairs.map((p) => {
        const r = info.get(p.requestId)!;
        const params = { sport: { bn: r.sport.nameBn, en: r.sport.nameEn }, venue: r.venueText, when: r.matchAt };
        return { userId: p.userId, type: "RATING_REMINDER" as const, data: { requestId: p.requestId, kind: "followup", ...paramsToData(params) } as Prisma.InputJsonObject, params, requestId: p.requestId };
      });
      await tx.notification.createMany({ data: rows.map(({ userId, type, data }) => ({ userId, type, data })) });
      return rows;
    },
    { timeout: 30_000 },
  );

  if (!sent) return 0; // another instance holds the lock
  for (const r of sent) {
    await pushOnly([r.userId], "RATING_REMINDER", { requestId: r.requestId, kind: "followup" }, r.params);
  }
  return sent.length;
}
