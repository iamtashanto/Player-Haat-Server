/**
 * Promote (or demote) a user by email. There is deliberately no API for this: the first admin
 * has to be created by someone with database/shell access.
 *
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:grant -- someone@example.com --revoke
 */
import { prisma } from "../lib/prisma.js";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!email || email.startsWith("--")) {
    console.error("Usage: npm run admin:grant -- <email> [--revoke]");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, status: true } });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  if (user.status !== "ACTIVE") {
    console.error(`${email} is ${user.status}; only active accounts can be admins`);
    process.exit(1);
  }
  const role = revoke ? "PLAYER" : "ADMIN";
  await prisma.user.update({ where: { id: user.id }, data: { role } });
  console.log(`${email}: ${user.role} → ${role}`);
}

main().finally(() => prisma.$disconnect());
