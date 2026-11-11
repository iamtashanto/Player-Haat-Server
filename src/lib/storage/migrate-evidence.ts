import type { Prisma } from "@prisma/client";
import { encryptEvidence } from "../evidence-crypto.js";
import { stripImageMetadata } from "../image-meta.js";
import { imageSize } from "../image-size.js";
import { sniffImageType } from "../image-sniff.js";
import { prisma } from "../prisma.js";

export interface EvidenceMigrationDeps {
  /** Downloads the old public copy. */
  fetchImage: (url: string) => Promise<Buffer>;
  /** Stores the encrypted text privately and returns its path. */
  putText: (text: string, opts: { folder: string; name: string }) => Promise<{ path: string; mediaId?: string }>;
  /** Removes the old PUBLIC copy. */
  deletePublic: (publicId: string) => Promise<void>;
  dryRun: boolean;
  log?: (line: string) => void;
}

export interface EvidenceMigrationReport {
  requests: number;
  found: number;
  moved: number;
  failed: number;
  publicCopiesDeleted: number;
}

type Entry = { url?: string; publicId: string };

/**
 * Moves verification evidence that was uploaded through the public image path into encrypted, private storage and
 * removes the public copies. A moved entry is dropped from the request's legacy list, so a second run finds nothing;
 * an entry that fails stays where it was and is retried next time.
 */
export async function migrateEvidenceToPrivate(deps: EvidenceMigrationDeps): Promise<EvidenceMigrationReport> {
  const log = deps.log ?? (() => undefined);
  const rows = await prisma.verificationRequest.findMany({ where: { evidenceImages: { not: null as never } }, select: { id: true, submitterId: true, evidenceImages: true } });
  const report: EvidenceMigrationReport = { requests: 0, found: 0, moved: 0, failed: 0, publicCopiesDeleted: 0 };
  for (const row of rows) {
    const entries = Array.isArray(row.evidenceImages) ? (row.evidenceImages as Entry[]) : [];
    if (entries.length === 0) continue;
    report.requests++;
    report.found += entries.length;
    if (deps.dryRun) {
      for (const e of entries) log(`[dry-run] would move evidence ${e.publicId} of request ${row.id}`);
      continue;
    }
    const left: Entry[] = [];
    for (const e of entries) {
      try {
        if (!e.url) throw new Error("no source url");
        const raw = await deps.fetchImage(e.url);
        const mime = sniffImageType(raw);
        if (!mime || mime === "image/heic") throw new Error("source is not a supported image");
        const clean = stripImageMetadata(raw, mime);
        const dims = imageSize(clean, mime);
        const stored = await deps.putText(encryptEvidence(clean, row.submitterId), { folder: `verification/${row.submitterId}`, name: `migrated-${row.id}` });
        await prisma.verificationFile.create({ data: { userId: row.submitterId, requestId: row.id, path: stored.path, mediaId: stored.mediaId ?? null, mime, width: dims?.width ?? null, height: dims?.height ?? null, size: clean.length } });
        report.moved++;
        try {
          await deps.deletePublic(e.publicId);
          report.publicCopiesDeleted++;
        } catch (err) {
          log(`PUBLIC COPY NOT DELETED (${e.publicId}): ${String(err)}`); // it is safe in private storage; delete it by hand
        }
      } catch (err) {
        report.failed++;
        left.push(e);
        log(`FAILED ${e.publicId}: ${String(err)}`);
      }
    }
    await prisma.verificationRequest.update({ where: { id: row.id }, data: { evidenceImages: left.length ? (left as unknown as Prisma.InputJsonValue) : (null as never) } });
  }
  return report;
}
