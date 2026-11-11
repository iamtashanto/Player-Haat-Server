/**
 * Fill the media facts (media id, mime, size, pixel width/height) for uploads made before we stored them.
 *
 *   npx tsx scripts/backfill-media-assets.ts --dry-run
 *   npx tsx scripts/backfill-media-assets.ts
 *
 * Needs MEDIA_BASE_URL + MEDIA_API_KEY. Safe to run twice.
 */
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { backfillMediaAssets } from "../src/lib/storage/backfill-assets.js";
import { TashantoMediaStorage } from "../src/lib/storage/tashanto.js";

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && (!env.MEDIA_BASE_URL || !env.MEDIA_API_KEY)) {
  console.error("MEDIA_BASE_URL and MEDIA_API_KEY must be set.");
  process.exit(1);
}
const storage = new TashantoMediaStorage();
const report = await backfillMediaAssets({ dryRun, log: (l) => console.log(l), lookup: (p) => storage.stat(p) });
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();
