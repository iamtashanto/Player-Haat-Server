/**
 * Creates the first (or another) administrator. There is no default admin and no API for this.
 *
 *   pnpm admin:create --email you@example.com --password '<12+ chars>' [--name "Your Name"]
 *
 * The account has no two-factor secret yet: the first dashboard sign-in forces the authenticator setup
 * (TOTP_SETUP_REQUIRED) before any session is issued, so it can't be used without 2FA.
 */
import { hashPassword } from "../lib/password.js";
import { prisma } from "../lib/prisma.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const password = arg("password");
  const name = arg("name")?.trim() || "Admin";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password || password.length < 12) {
    console.error("Usage: pnpm admin:create --email <email> --password <at least 12 characters> [--name <name>]");
    process.exit(1);
  }
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    console.error(`A user with ${email} already exists. Use admin:grant to promote it.`);
    process.exit(1);
  }
  await prisma.user.create({
    data: {
      name,
      email,
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
      role: "ADMIN",
      authAccounts: { create: { provider: "EMAIL", providerUserId: email } },
    },
  });
  console.log(`Admin ${email} created. Sign in at the admin dashboard; you will be asked to set up two-factor first.`);
}

main().finally(() => prisma.$disconnect());
