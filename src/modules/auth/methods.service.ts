import { Prisma, type AuthProvider } from "@prisma/client";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { SocialProfile } from "../../lib/social/types.js";
import { verifyCode } from "./otp.service.js";
import { toAuthUser, type UserWithAccounts } from "./auth.presenter.js";

const withAccounts = { authAccounts: { select: { provider: true } } } as const;
const fetchUser = (id: string): Promise<UserWithAccounts> =>
  prisma.user.findUniqueOrThrow({ where: { id }, include: withAccounts });

export async function listMethods(userId: string) {
  return toAuthUser(await fetchUser(userId));
}

/** Adds Google/Apple to the signed-in user. A provider identity can belong to only one user. */
export async function linkProvider(userId: string, profile: SocialProfile) {
  const existing = await prisma.authAccount.findUnique({
    where: { provider_providerUserId: { provider: profile.provider, providerUserId: profile.providerUserId } },
  });
  if (existing && existing.userId !== userId) {
    throw AppError.conflict(ErrorCode.AUTH_PROVIDER_ALREADY_LINKED, "That account is linked to another user");
  }

  if (!existing) {
    try {
      await prisma.authAccount.create({
        data: { userId, provider: profile.provider, providerUserId: profile.providerUserId },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw AppError.conflict(ErrorCode.AUTH_PROVIDER_ALREADY_LINKED, "That account is already linked");
      }
      throw err;
    }
  }

  // A verified provider email can fill in / verify the user's email, never replace a different one.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (profile.email && profile.emailVerified) {
    if (!user.email) {
      const taken = await prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (!taken) {
        await prisma.user.update({ where: { id: userId }, data: { email: profile.email, emailVerifiedAt: new Date() } });
      }
    } else if (user.email === profile.email && !user.emailVerifiedAt) {
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    }
  }
  return toAuthUser(await fetchUser(userId));
}

/** Adds a verified phone number (proved with an SMS code) as a login method. */
export async function linkPhone(userId: string, input: { phone: string; code: string }) {
  await verifyCode("PHONE_OTP", input.phone, input.code);

  const [taken, mine] = await Promise.all([
    prisma.authAccount.findUnique({ where: { provider_providerUserId: { provider: "PHONE", providerUserId: input.phone } } }),
    prisma.authAccount.findFirst({ where: { userId, provider: "PHONE" } }),
  ]);
  if (taken && taken.userId === userId) return toAuthUser(await fetchUser(userId));
  if (taken) throw AppError.conflict(ErrorCode.AUTH_PROVIDER_ALREADY_LINKED, "That number belongs to another account");
  if (mine) throw AppError.conflict(ErrorCode.AUTH_PROVIDER_ALREADY_LINKED, "Remove your current phone number first");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { phone: input.phone, phoneVerifiedAt: null, id: { not: userId } }, data: { phone: null } }); // release an unverified claim
      await tx.user.update({ where: { id: userId }, data: { phone: input.phone, phoneVerifiedAt: new Date() } });
      await tx.authAccount.create({ data: { userId, provider: "PHONE", providerUserId: input.phone } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict(ErrorCode.AUTH_PROVIDER_ALREADY_LINKED, "That number is already in use");
    }
    throw err;
  }
  return toAuthUser(await fetchUser(userId));
}

/** Removes a login method, but never the last one — the user would be locked out of their account. */
export async function unlinkProvider(userId: string, provider: AuthProvider) {
  await prisma.$transaction(async (tx) => {
    // Lock the user row so two concurrent unlinks can't both see "2 methods left".
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const accounts = await tx.authAccount.findMany({ where: { userId } });
    if (!accounts.some((a) => a.provider === provider)) {
      throw AppError.notFound(ErrorCode.AUTH_PROVIDER_NOT_LINKED, "Login method not linked");
    }
    if (accounts.length <= 1) {
      throw AppError.conflict(ErrorCode.AUTH_LAST_LOGIN_METHOD, "Cannot remove your only login method");
    }
    await tx.authAccount.deleteMany({ where: { userId, provider } });
    if (provider === "EMAIL") await tx.user.update({ where: { id: userId }, data: { passwordHash: null } });
    // The number stays on the profile as a contact number, but it's no longer proven.
    if (provider === "PHONE") await tx.user.update({ where: { id: userId }, data: { phoneVerifiedAt: null } });
  });
  return toAuthUser(await fetchUser(userId));
}
