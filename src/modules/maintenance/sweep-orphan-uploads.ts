import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage/index.js";
import { STORAGE_PREFIX } from "../../lib/storage/paths.js";

const HOUR = 3_600_000;

export interface SweepResult {
  scanned: number;
  deleted: number;
  skipped?: "storage-not-configured";
}

/**
 * Deletes uploads nothing points at. They come from `POST /media/images` (uploaded, never attached),
 * from failed cleanups after a DB error, and from deleted accounts whose provider call failed.
 *
 * Guard rails, since this deletes user data:
 *  - only assets under THIS environment's prefix are even listed (dev can't touch production's);
 *  - only assets older than `minAgeHours` (an upload in flight isn't an orphan yet);
 *  - an asset is kept if ANY row references it (avatar, player photo, team logo, verification evidence);
 *  - bounded per run, and one failed delete never stops the rest.
 */
export async function sweepOrphanUploads(now = new Date(), opts: { minAgeHours?: number; maxScan?: number } = {}): Promise<SweepResult> {
  const olderThan = new Date(now.getTime() - (opts.minAgeHours ?? 24) * HOUR);

  let candidates: Array<{ publicId: string }>;
  try {
    candidates = await storage.listImages({ prefix: STORAGE_PREFIX, olderThan, limit: opts.maxScan ?? 2000 });
  } catch (err) {
    if (err instanceof AppError && err.code === "STORAGE_NOT_CONFIGURED") return { scanned: 0, deleted: 0, skipped: "storage-not-configured" };
    throw err;
  }
  const ids = candidates.map((c) => c.publicId).filter((id) => id.startsWith(STORAGE_PREFIX)); // belt and braces
  if (ids.length === 0) return { scanned: 0, deleted: 0 };

  const [avatars, photos, logos, evidence] = await Promise.all([
    prisma.user.findMany({ where: { avatarPublicId: { in: ids } }, select: { avatarPublicId: true } }),
    prisma.playerMedia.findMany({ where: { publicId: { in: ids } }, select: { publicId: true } }),
    prisma.team.findMany({ where: { logoPublicId: { in: ids } }, select: { logoPublicId: true } }),
    // Verification evidence lives inside a JSON array on the request row.
    prisma.$queryRaw<{ publicId: string }[]>`
      SELECT elem->>'publicId' AS "publicId" FROM "VerificationRequest", jsonb_array_elements(COALESCE("evidenceImages", '[]'::jsonb)) elem
      WHERE elem->>'publicId' = ANY(${ids})`,
  ]);
  const referenced = new Set<string>([...avatars.map((a) => a.avatarPublicId!), ...photos.map((p) => p.publicId!), ...logos.map((l) => l.logoPublicId!), ...evidence.map((e) => e.publicId)]);
  const orphans = ids.filter((id) => !referenced.has(id));

  let deleted = 0;
  for (const id of orphans) {
    try {
      await storage.deleteImage(id);
      deleted++;
    } catch (err) {
      logger.warn({ publicId: id, err }, "orphan sweep: delete failed, will retry next run");
    }
  }
  return { scanned: ids.length, deleted };
}
