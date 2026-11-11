/**
 * Delete the accounts created by automated test runs (e-mail ending in @e2e.test) with everything they own, including
 * their files in the media service. Real users are never touched.
 *
 *   npx tsx scripts/cleanup-e2e-data.ts --dry-run   # count what would go
 *   npx tsx scripts/cleanup-e2e-data.ts             # do it
 *
 * Refuses to run when NODE_ENV=production unless --allow-production is given (production should not hold test users).
 */
import { env } from "../src/config/env.js";
import { cleanupE2eData } from "../src/lib/e2e-cleanup.js";
import { prisma } from "../src/lib/prisma.js";
import { storage } from "../src/lib/storage/index.js";

const dryRun = process.argv.includes("--dry-run");
if (env.NODE_ENV === "production" && !process.argv.includes("--allow-production")) {
  console.error("Refusing to run against production without --allow-production.");
  process.exit(1);
}
const report = await cleanupE2eData({ dryRun, log: (l) => console.log(l), deleteFile: (p) => storage.deleteImage(p) });
console.log(JSON.stringify({ dryRun, ...report }, null, 2));
await prisma.$disconnect();
