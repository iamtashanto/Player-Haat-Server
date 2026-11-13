/**
 * DEV ONLY: creates (or resets) a local admin with a short password so you can sign in to the dashboard while developing.
 *
 *   pnpm admin:create:dev                       → admin@gmail.com / admin123
 *   pnpm admin:create:dev --email a@b.co --password secret
 *
 * Refuses to run when NODE_ENV=production. For a real admin use `pnpm admin:create` (12+ character password).
 */
import { hashPassword } from "../lib/password.js";
import { prisma } from "../lib/prisma.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("admin:create:dev is for development only. Use `pnpm admin:create` in production.");
    process.exit(1);
  }
  const email = (arg("email") ?? "admin@gmail.com").trim().toLowerCase();
  const password = arg("password") ?? "admin123";
  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { role: "ADMIN", passwordHash, emailVerifiedAt: new Date(), status: "ACTIVE" } });
    console.log(`Existing user ${email} is now an ADMIN and the password was reset.`);
  } else {
    await prisma.user.create({
      data: { name: "Admin", email, emailVerifiedAt: new Date(), passwordHash, role: "ADMIN", authAccounts: { create: { provider: "EMAIL", providerUserId: email } } },
    });
    console.log(`Admin ${email} created.`);
  }
  console.log("Sign in at the admin dashboard (dev: two-factor is off unless ADMIN_REQUIRE_2FA=true).");
}

main().finally(() => prisma.$disconnect());
