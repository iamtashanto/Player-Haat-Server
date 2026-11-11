/**
 * Development-only demo data (marked users @demo.playerhaat.test; wipe with `pnpm cleanup:demo`).
 * Refuses to run in production or against a production-looking database.
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { seedDemo } from "../prisma/seed/demo.js";

dotenv.config({ quiet: true });

const url = process.env.DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1|\[::1\]|db)(:|\/)/.test(url);
if (process.env.NODE_ENV === "production" || !local) {
  console.error("Refusing to seed demo data: NODE_ENV=production or DATABASE_URL is not a local database.");
  process.exit(1);
}
const prisma = new PrismaClient();
console.log("demo", await seedDemo(prisma));
await prisma.$disconnect();
