import { sniffImageType } from "../image-sniff.js";
import { stripImageMetadata } from "../image-meta.js";
import { prisma } from "../prisma.js";
import { newPublicId } from "./paths.js";
import type { ImageKind, StoredImage } from "./types.js";

/**
 * Moves images that still live on the old provider (Cloudinary) into the current storage and rewrites the
 * references. Safe to run twice: a migrated row has a new path and is skipped, and a row that fails keeps its
 * old reference untouched, so the next run simply retries it.
 */
export interface MigrationDeps {
  /** Downloads an image from its old delivery URL. */
  fetchImage: (url: string) => Promise<Buffer>;
  /** Uploads to the new storage. */
  upload: (buffer: Buffer, opts: { kind: ImageKind; publicId: string }) => Promise<StoredImage>;
  /** Removes the old asset once the row points at the new one. Failures are counted, never thrown. */
  deleteOld: (publicId: string) => Promise<void>;
  dryRun: boolean;
  log?: (line: string) => void;
}

export interface MigrationReport {
  found: number;
  migrated: number;
  failed: number;
  skippedAlreadyMigrated: number;
  oldDeleted: number;
  byKind: Record<string, number>;
}

/** New-storage paths end in a file extension; Cloudinary public ids never do. */
export const isLegacyPublicId = (publicId: string | null | undefined): publicId is string => !!publicId && !/\.[a-z0-9]{3,5}$/i.test(publicId);

type Job = { kind: ImageKind; ownerId: string; url: string | null; publicId: string; apply: (next: StoredImage) => Promise<void> };

async function collect(): Promise<{ jobs: Job[]; already: number }> {
  const jobs: Job[] = [];
  let already = 0;
  const take = (publicId: string | null, url: string | null, job: Omit<Job, "publicId" | "url">) => {
    if (!publicId) return;
    if (!isLegacyPublicId(publicId)) {
      already++;
      return;
    }
    jobs.push({ ...job, publicId, url });
  };

  for (const u of await prisma.user.findMany({ where: { avatarPublicId: { not: null } }, select: { id: true, avatarUrl: true, avatarPublicId: true } })) {
    take(u.avatarPublicId, u.avatarUrl, { kind: "avatar", ownerId: u.id, apply: (n) => prisma.user.update({ where: { id: u.id }, data: { avatarUrl: n.url, avatarPublicId: n.publicId } }).then(() => undefined) });
  }
  for (const m of await prisma.playerMedia.findMany({ where: { type: "PHOTO", publicId: { not: null } }, select: { id: true, url: true, publicId: true, profile: { select: { userId: true } } } })) {
    take(m.publicId, m.url, { kind: "player-photo", ownerId: m.profile.userId, apply: (n) => prisma.playerMedia.update({ where: { id: m.id }, data: { url: n.url, publicId: n.publicId } }).then(() => undefined) });
  }
  for (const t of await prisma.team.findMany({ where: { logoPublicId: { not: null } }, select: { id: true, captainId: true, logoUrl: true, logoPublicId: true } })) {
    take(t.logoPublicId, t.logoUrl, { kind: "team-logo", ownerId: t.captainId, apply: (n) => prisma.team.update({ where: { id: t.id }, data: { logoUrl: n.url, logoPublicId: n.publicId } }).then(() => undefined) });
  }
  return { jobs, already };
}

export async function migrateLegacyImages(deps: MigrationDeps): Promise<MigrationReport> {
  const log = deps.log ?? (() => undefined);
  const { jobs, already } = await collect();
  const report: MigrationReport = { found: jobs.length, migrated: 0, failed: 0, skippedAlreadyMigrated: already, oldDeleted: 0, byKind: {} };
  for (const job of jobs) {
    report.byKind[job.kind] = (report.byKind[job.kind] ?? 0) + 1;
    if (deps.dryRun) {
      log(`[dry-run] would move ${job.kind} ${job.publicId}`);
      continue;
    }
    try {
      if (!job.url) throw new Error("no source url");
      const raw = await deps.fetchImage(job.url);
      const mime = sniffImageType(raw);
      if (!mime) throw new Error("source is not a supported image");
      const next = await deps.upload(stripImageMetadata(raw, mime), { kind: job.kind, publicId: newPublicId(job.kind, job.ownerId) });
      await job.apply(next);
      report.migrated++;
      try {
        await deps.deleteOld(job.publicId);
        report.oldDeleted++;
      } catch (err) {
        log(`old asset not deleted (${job.publicId}): ${String(err)}`);
      }
    } catch (err) {
      report.failed++;
      log(`FAILED ${job.kind} ${job.publicId}: ${String(err)}`);
    }
  }
  return report;
}
