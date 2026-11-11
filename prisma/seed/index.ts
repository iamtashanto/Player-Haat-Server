import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { seedAppConfig } from "./app-config.js";
import { seedLocations } from "./locations.js";
import { seedSports } from "./sports.js";

dotenv.config({ quiet: true });

const prisma = new PrismaClient();

async function main() {
  // Reference data only. Demo/dev users live in scripts/seed-dev.ts (`pnpm db:seed:dev`).
  console.log("locations  ", await seedLocations(prisma));
  console.log("sports     ", await seedSports(prisma));
  console.log("app-config ", await seedAppConfig(prisma));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
