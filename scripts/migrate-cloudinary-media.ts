/**
 * One-off: move images from Cloudinary to the media service and rewrite their references.
 *
 *   npx tsx scripts/migrate-cloudinary-media.ts --dry-run    # count what would move, change nothing
 *   npx tsx scripts/migrate-cloudinary-media.ts              # do it
 *
 * Needs both providers configured: MEDIA_BASE_URL + MEDIA_API_KEY (destination) and CLOUDINARY_* (to delete the
 * old copies). Safe to run twice; rows that already point at the new storage are skipped. The key is read from
 * the environment only and is never printed.
 */
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { CloudinaryStorage } from "../src/lib/storage/cloudinary.js";
import { migrateLegacyImages } from "../src/lib/storage/migrate-legacy.js";
import { TashantoMediaStorage } from "../src/lib/storage/tashanto.js";

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && (!env.MEDIA_BASE_URL || !env.MEDIA_API_KEY)) {
  console.error("MEDIA_BASE_URL and MEDIA_API_KEY must be set to migrate.");
  process.exit(1);
}
const target = new TashantoMediaStorage();
const old = new CloudinaryStorage();

const report = await migrateLegacyImages({
  dryRun,
  log: (l) => console.log(l),
  fetchImage: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  },
  upload: (buf, opts) => target.uploadImage(buf, opts),
  deleteOld: (id) => old.deleteImage(id),
});
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();
