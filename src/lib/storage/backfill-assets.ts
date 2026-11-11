import { prisma } from "../prisma.js";

export interface AssetFacts {
  mediaId: string;
  mime: string;
  width: number | null;
  height: number | null;
  size: number | null;
}
export interface BackfillDeps {
  /** Asks the media service about a path; null when it no longer exists. */
  lookup: (path: string) => Promise<AssetFacts | null>;
  dryRun: boolean;
  log?: (line: string) => void;
}
export interface BackfillReport {
  referenced: number;
  alreadyKnown: number;
  filled: number;
  missingInService: number;
  failed: number;
}

/** Every image path our tables point at (avatars, covers, gallery photos, team logos). */
async function referencedPaths(): Promise<string[]> {
  const [a, c, p, t] = await Promise.all([
    prisma.user.findMany({ where: { avatarPublicId: { not: null } }, select: { avatarPublicId: true } }),
    prisma.playerProfile.findMany({ where: { coverPublicId: { not: null } }, select: { coverPublicId: true } }),
    prisma.playerMedia.findMany({ where: { publicId: { not: null } }, select: { publicId: true } }),
    prisma.team.findMany({ where: { logoPublicId: { not: null } }, select: { logoPublicId: true } }),
  ]);
  return [...new Set([...a.map((x) => x.avatarPublicId!), ...c.map((x) => x.coverPublicId!), ...p.map((x) => x.publicId!), ...t.map((x) => x.logoPublicId!)])];
}

/** Fills `MediaAsset` for uploads made before we kept their facts. Safe to run twice: known paths are skipped. */
export async function backfillMediaAssets(deps: BackfillDeps): Promise<BackfillReport> {
  const log = deps.log ?? (() => undefined);
  const paths = await referencedPaths();
  const known = new Set((await prisma.mediaAsset.findMany({ where: { path: { in: paths } }, select: { path: true } })).map((r) => r.path));
  const report: BackfillReport = { referenced: paths.length, alreadyKnown: known.size, filled: 0, missingInService: 0, failed: 0 };
  for (const path of paths.filter((x) => !known.has(x))) {
    if (deps.dryRun) {
      log(`[dry-run] would look up ${path}`);
      report.filled++;
      continue;
    }
    try {
      const f = await deps.lookup(path);
      if (!f) {
        report.missingInService++;
        log(`not in the media service: ${path}`);
        continue;
      }
      await prisma.mediaAsset.upsert({ where: { path }, create: { path, ...f }, update: f });
      report.filled++;
    } catch (err) {
      report.failed++;
      log(`FAILED ${path}: ${String(err)}`);
    }
  }
  return report;
}
