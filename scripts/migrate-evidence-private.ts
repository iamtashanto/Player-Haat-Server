/**
 * One-off: move verification evidence from public image URLs into encrypted, private storage, and delete the public
 * copies.
 *
 *   npx tsx scripts/migrate-evidence-private.ts --dry-run   # count what would move, change nothing
 *   npx tsx scripts/migrate-evidence-private.ts             # do it
 *
 * Needs MEDIA_BASE_URL + MEDIA_API_KEY and EVIDENCE_ENCRYPTION_KEY. Safe to run twice.
 */
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { migrateEvidenceToPrivate } from "../src/lib/storage/migrate-evidence.js";
import { TashantoMediaStorage } from "../src/lib/storage/tashanto.js";
import { evidenceConfigured } from "../src/lib/evidence-crypto.js";

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && (!env.MEDIA_BASE_URL || !env.MEDIA_API_KEY || !evidenceConfigured())) {
  console.error("MEDIA_BASE_URL, MEDIA_API_KEY and EVIDENCE_ENCRYPTION_KEY must be set.");
  process.exit(1);
}
const storage = new TashantoMediaStorage();
const report = await migrateEvidenceToPrivate({
  dryRun,
  log: (l) => console.log(l),
  fetchImage: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  },
  putText: (t, o) => storage.putText(t, o),
  deletePublic: (id) => storage.deleteImage(id),
});
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();
