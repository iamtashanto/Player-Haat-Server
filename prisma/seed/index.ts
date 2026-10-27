import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { seedAppConfig } from "./app-config.js";
import { seedDemo } from "./demo.js";
import { seedLocations } from "./locations.js";
import { seedSports } from "./sports.js";

dotenv.config({ quiet: true });

const prisma = new PrismaClient();

async function main() {
  const withDemo = process.argv.includes("--demo");
  if (withDemo && process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data when NODE_ENV=production");
  }

  console.log("locations  ", await seedLocations(prisma));
  console.log("sports     ", await seedSports(prisma));
  console.log("app-config ", await seedAppConfig(prisma));
  if (withDemo) console.log("demo       ", await seedDemo(prisma));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
