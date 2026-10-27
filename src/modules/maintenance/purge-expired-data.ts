import { prisma } from "../../lib/prisma.js";

const DAY = 86_400_000;

export interface PurgeResult {
  refreshTokens: number;
  verificationCodes: number;
  notifications: number;
}

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
 *  - notifications older than `notificationDays` (default 180).
 * Idempotent; safe on several instances at once.
 */
export async function purgeExpiredData(now = new Date(), opts: { chunk?: number; notificationDays?: number } = {}): Promise<PurgeResult> {
  const chunk = opts.chunk ?? 5000;
  const t = now.getTime();
  const tokensBefore = utc(t - 7 * DAY);
  const codesBefore = utc(t - 2 * DAY);
  const notificationsBefore = utc(t - (opts.notificationDays ?? 180) * DAY);

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
  const notifications = await deleteInChunks(
    (n) => prisma.$executeRaw`DELETE FROM "Notification" WHERE id IN (SELECT id FROM "Notification" WHERE "createdAt" < ${notificationsBefore}::timestamp LIMIT ${n})`,
    chunk,
  );
  return { refreshTokens, verificationCodes, notifications };
}
