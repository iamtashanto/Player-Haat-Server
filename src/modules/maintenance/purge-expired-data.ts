import { prisma } from "../../lib/prisma.js";
import { purgeTelemetry } from "../telemetry/telemetry.service.js";

const DAY = 86_400_000;

export interface PurgeResult {
  refreshTokens: number;
  verificationCodes: number;
  notifications: number;
  pushLog: number;
  telemetry: number;
  profileViews: number;
}

/** How long things are kept. Short enough that the tables stay small, long enough to be useful. */
export const RETENTION = {
  readNotificationDays: 30,
  anyNotificationDays: 90,
  notificationsPerUser: 300,
  profileViewDays: 180,
};

/** `timestamp` columns hold UTC; bind UTC text so a non-UTC DB session can't skew the cutoff. */
const utc = (ms: number) => new Date(ms).toISOString();

/** Deletes in chunks so one run never holds a long lock or bloats the WAL. Returns rows deleted. */
async function deleteInChunks(run: (limit: number) => Promise<number>, chunk: number): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run(chunk);
    total += n;
    if (n < chunk) return total;
  }
}

/**
 * Housekeeping for tables that otherwise grow forever:
 *  - refresh tokens a week past their expiry (revoked or not; a replayed token that old is rejected anyway);
 *  - verification codes two days past expiry/use;
 *  - notifications: read ones after 30 days, any after 90, and never more than the newest 300 per person;
 *  - profile views ("who viewed me") after 180 days;
 *  - finished push-log rows (sent, failed, skipped) older than 30 days — the queue itself is never touched.
 * Idempotent; safe on several instances at once.
 */
export async function purgeExpiredData(now = new Date(), opts: { chunk?: number; notificationDays?: number } = {}): Promise<PurgeResult> {
  const chunk = opts.chunk ?? 5000;
  const t = now.getTime();
  const tokensBefore = utc(t - 7 * DAY);
  const codesBefore = utc(t - 2 * DAY);

  const refreshTokens = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "RefreshToken" WHERE id IN (SELECT id FROM "RefreshToken" WHERE "expiresAt" < ${tokensBefore}::timestamp LIMIT ${n})`,
    chunk,
  );
  const verificationCodes = await deleteInChunks(
    (n) =>
      prisma.$executeRaw`DELETE FROM "VerificationCode" WHERE id IN (
        SELECT id FROM "VerificationCode" WHERE "expiresAt" < ${codesBefore}::timestamp OR "consumedAt" < ${codesBefore}::timestamp LIMIT ${n})`,
    chunk,
  );
  const anyBefore = utc(t - (opts.notificationDays ?? RETENTION.anyNotificationDays) * DAY);
  const readBefore = utc(t - RETENTION.readNotificationDays * DAY);
  const old = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "Notification" WHERE id IN (SELECT id FROM "Notification" WHERE "createdAt" < ${anyBefore}::timestamp OR ("readAt" IS NOT NULL AND "createdAt" < ${readBefore}::timestamp) LIMIT ${n})`,
    chunk,
  );
  // a person who gets hundreds of alerts keeps the newest few hundred, however recent
  const overCap = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "Notification" WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY "userId" ORDER BY "createdAt" DESC, id DESC) AS rn
        FROM "Notification"
        WHERE "userId" IN (SELECT "userId" FROM "Notification" GROUP BY "userId" HAVING count(*) > ${RETENTION.notificationsPerUser})
      ) ranked WHERE rn > ${RETENTION.notificationsPerUser} LIMIT ${n})`,
    chunk,
  );
  const notifications = old + overCap;
  const profileViews = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "ProfileView" WHERE id IN (SELECT id FROM "ProfileView" WHERE "createdAt" < ${utc(t - RETENTION.profileViewDays * DAY)}::timestamp LIMIT ${n})`,
    chunk,
  );
  const pushLog = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "PushJob" WHERE id IN (SELECT id FROM "PushJob" WHERE status IN ('SENT','FAILED','SKIPPED') AND "createdAt" < ${utc(t - 30 * DAY)}::timestamp LIMIT ${n})`,
    chunk,
  );
  const telemetry = await purgeTelemetry(new Date(t - 90 * DAY));
  return { refreshTokens, verificationCodes, notifications, pushLog, telemetry, profileViews };
}
