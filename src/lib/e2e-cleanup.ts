import { prisma } from "./prisma.js";

/** Every account made by an automated test run uses this reserved e-mail domain. Nothing else is ever touched. */
export const E2E_EMAIL_SUFFIX = "@e2e.test";

export interface CleanupDeps {
  /** Removes one stored file (image or private document). Failures are counted, never thrown. */
  deleteFile: (path: string) => Promise<void>;
  dryRun: boolean;
  log?: (line: string) => void;
}
export interface CleanupReport {
  users: number;
  files: number;
  filesDeleted: number;
  filesFailed: number;
  requests: number;
  teams: number;
}

/** The users a run would remove: e-mail on the e2e domain, nothing else. */
export const e2eUsers = () => prisma.user.findMany({ where: { email: { endsWith: E2E_EMAIL_SUFFIX, mode: "insensitive" } }, select: { id: true } });

/**
 * Deletes the accounts created by e2e runs together with everything they own, including their files in the media
 * service. Safe to run twice (the second run finds nothing). `dryRun` only counts.
 */
export async function cleanupE2eData(deps: CleanupDeps): Promise<CleanupReport> {
  const log = deps.log ?? (() => undefined);
  const ids = (await e2eUsers()).map((u) => u.id);
  const report: CleanupReport = { users: ids.length, files: 0, filesDeleted: 0, filesFailed: 0, requests: 0, teams: 0 };
  if (ids.length === 0) return report;

  const [avatars, covers, photos, teamLogos, orgLogos, docs, requests, teams] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids }, avatarPublicId: { not: null } }, select: { avatarPublicId: true } }),
    prisma.playerProfile.findMany({ where: { userId: { in: ids }, coverPublicId: { not: null } }, select: { coverPublicId: true } }),
    prisma.playerMedia.findMany({ where: { profile: { userId: { in: ids } }, publicId: { not: null } }, select: { publicId: true } }),
    prisma.team.findMany({ where: { captainId: { in: ids }, logoPublicId: { not: null } }, select: { logoPublicId: true } }),
    prisma.recruiterProfile.findMany({ where: { userId: { in: ids }, logoPublicId: { not: null } }, select: { logoPublicId: true } }),
    prisma.verificationFile.findMany({ where: { userId: { in: ids } }, select: { path: true } }),
    prisma.playerRequest.count({ where: { createdById: { in: ids } } }),
    prisma.team.count({ where: { captainId: { in: ids } } }),
  ]);
  const paths = [...new Set([...avatars.map((x) => x.avatarPublicId!), ...covers.map((x) => x.coverPublicId!), ...photos.map((x) => x.publicId!), ...teamLogos.map((x) => x.logoPublicId!), ...orgLogos.map((x) => x.logoPublicId!), ...docs.map((x) => x.path)])];
  report.files = paths.length;
  report.requests = requests;
  report.teams = teams;
  if (deps.dryRun) {
    log(`[dry-run] would delete ${ids.length} users, ${requests} requests, ${teams} teams and ${paths.length} files`);
    return report;
  }

  // Files first: if the database step fails, the next run still finds the users (and their paths) and finishes the job.
  for (const path of paths) {
    try {
      await deps.deleteFile(path);
      report.filesDeleted++;
    } catch (err) {
      report.filesFailed++;
      log(`file not deleted (${path}): ${String(err)}`);
    }
  }
  await prisma.mediaAsset.deleteMany({ where: { path: { in: paths } } });

  // These foreign keys are RESTRICT (a person can't vanish from someone else's history), so clear them first. Only
  // rows that belong to e2e accounts are touched: other people's ratings of an e2e player go with the rating.
  await prisma.$transaction(
    async (tx) => {
      await tx.rating.deleteMany({ where: { OR: [{ raterId: { in: ids } }, { rateeId: { in: ids } }, { request: { createdById: { in: ids } } }] } });
      await tx.report.deleteMany({ where: { reporterId: { in: ids } } });
      await tx.adminAction.deleteMany({ where: { adminId: { in: ids } } });
      await tx.application.deleteMany({ where: { OR: [{ playerId: { in: ids } }, { request: { createdById: { in: ids } } }] } });
      await tx.playerRequest.deleteMany({ where: { createdById: { in: ids } } });
      await tx.team.deleteMany({ where: { captainId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    },
    { timeout: 120_000 },
  );
  return report;
}
