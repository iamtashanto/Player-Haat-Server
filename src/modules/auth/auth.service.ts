import { Prisma, type User } from "@prisma/client";
import { env } from "../../config/env.js";
import { OTP } from "./auth.constants.js";
import { sms } from "../../lib/sms/index.js";
import { renderCodeEmail, type EmailKind } from "../../i18n/email-templates.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { sendMail } from "../../lib/mailer.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import type { SocialProfile } from "../../lib/social/types.js";
import { toAuthUser, type UserWithAccounts } from "./auth.presenter.js";
import { issueCode, verifyCode } from "./otp.service.js";
import { issueTokens, revokeAllForUser, type SessionContext } from "./token.service.js";

const withAccounts = { authAccounts: { select: { provider: true } } } as const;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Session-ready result: the user plus a fresh token pair. */
async function startSession(user: UserWithAccounts, ctx: SessionContext) {
  return { user: toAuthUser(user), tokens: await issueTokens(user, ctx) };
}

/** Deleted accounts look like they never existed; suspended ones are told so (after proving identity). */
function assertCanSignIn(user: Pick<User, "status">) {
  if (user.status === "SUSPENDED") throw AppError.forbidden(ErrorCode.AUTH_ACCOUNT_SUSPENDED);
  if (user.status === "DELETED") throw AppError.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS);
}

/** Email delivery must never fail a request that already changed state — the user can resend. */
async function sendCodeEmail(kind: EmailKind, user: Pick<User, "name" | "email" | "locale">, code: string, expiresMinutes: number) {
  try {
    await sendMail(renderCodeEmail(kind, user.locale, { to: user.email!, name: user.name, code, expiresMinutes }));
  } catch (err) {
    logger.error({ err, kind }, "failed to send auth email");
  }
}

/** Keeps the EMAIL AuthAccount in step with the user's email once they have a password. */
async function ensureEmailAccount(tx: Prisma.TransactionClient, userId: string, email: string) {
  await tx.authAccount.upsert({
    where: { provider_providerUserId: { provider: "EMAIL", providerUserId: email } },
    update: {},
    create: { userId, provider: "EMAIL", providerUserId: email },
  });
}

// ─────────────────────────── email + password ───────────────────────────

export async function register(
  input: { name: string; email: string; password: string; locale?: "bn" | "en" },
  ctx: SessionContext,
) {
  const passwordHash = await hashPassword(input.password);
  let user: UserWithAccounts;
  try {
    user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        locale: input.locale ?? "bn",
        authAccounts: { create: { provider: "EMAIL", providerUserId: input.email } },
      },
      include: withAccounts,
    });
  } catch (err) {
    // Unique on User.email / AuthAccount(provider, providerUserId).
    // Trade-off: this reveals that an email is registered. Accepted for signup UX; login/forgot do not leak.
    if (isUniqueViolation(err)) throw AppError.conflict(ErrorCode.AUTH_EMAIL_TAKEN, "Email already registered");
    throw err;
  }

  const { code, expiresMinutes } = await issueCode("EMAIL_VERIFY", input.email, { userId: user.id });
  await sendCodeEmail("verify", user, code, expiresMinutes);
  return startSession(user, ctx);
}

export async function login(input: { email: string; password: string }, ctx: SessionContext) {
  const user = await prisma.user.findUnique({ where: { email: input.email }, include: withAccounts });
  if (!user?.passwordHash || user.status === "DELETED") {
    await burnPasswordCheck(input.password); // same cost whether or not the account exists
    throw AppError.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid email or password");
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw AppError.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid email or password");
  }
  assertCanSignIn(user);
  return startSession(user, ctx);
}

export async function verifyEmail(input: { email: string; code: string }) {
  await verifyCode("EMAIL_VERIFY", input.email, input.code);
  const { count } = await prisma.user.updateMany({
    where: { email: input.email, status: "ACTIVE", emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
  return { verified: true, alreadyVerified: count === 0 };
}

export async function resendVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.email) throw AppError.conflict(ErrorCode.AUTH_NO_EMAIL, "Account has no email address");
  if (user.emailVerifiedAt) throw AppError.conflict(ErrorCode.AUTH_EMAIL_ALREADY_VERIFIED);
  const { code, expiresMinutes } = await issueCode("EMAIL_VERIFY", user.email, {
    userId,
    enforceCooldown: true,
  });
  await sendCodeEmail("verify", user, code, expiresMinutes);
}

/** Always succeeds from the caller's point of view, so it can't be used to discover registered emails. */
export async function forgotPassword(input: { email: string }) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || user.status !== "ACTIVE") return;
  try {
    const { code, expiresMinutes } = await issueCode("PASSWORD_RESET", input.email, {
      userId: user.id,
      enforceCooldown: true,
    });
    await sendCodeEmail("reset", user, code, expiresMinutes);
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.AUTH_OTP_COOLDOWN) return; // swallow: no oracle
    throw err;
  }
}

export async function resetPassword(input: { email: string; code: string; newPassword: string }) {
  await verifyCode("PASSWORD_RESET", input.email, input.code);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || user.status !== "ACTIVE") throw AppError.badRequest(ErrorCode.AUTH_INVALID_OTP, "Invalid code");

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      // Receiving the code proves control of the mailbox, so the email counts as verified.
      data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    });
    await ensureEmailAccount(tx, user.id, input.email);
    await revokeAllForUser(user.id, tx); // a reset must kick out whoever knew the old password
  });
}

/**
 * Set a password (social-only users) or change it (requires the current one).
 * All sessions are revoked and a fresh pair is returned for the calling device.
 */
export async function setPassword(
  userId: string,
  input: { currentPassword?: string; newPassword: string },
  ctx: SessionContext,
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: withAccounts });
  if (!user.email) throw AppError.conflict(ErrorCode.AUTH_NO_EMAIL, "Add an email address before setting a password");

  if (user.passwordHash) {
    if (!input.currentPassword) throw AppError.badRequest(ErrorCode.AUTH_PASSWORD_REQUIRED, "Current password required");
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw AppError.badRequest(ErrorCode.AUTH_WRONG_PASSWORD, "Current password is incorrect");
    }
  }

  const passwordHash = await hashPassword(input.newPassword);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: userId }, data: { passwordHash }, include: withAccounts });
    await ensureEmailAccount(tx, userId, user.email!);
    await revokeAllForUser(userId, tx);
    return tx.user.findUniqueOrThrow({ where: { id: u.id }, include: withAccounts });
  });
  return startSession(updated, ctx);
}

// ─────────────────────────── social login (Google / Apple) ───────────────────────────

/**
 * 1. Known provider account  → that user.
 * 2. Verified email matches an existing user → link the provider to them.
 * 3. Otherwise → create a new user.
 */
export async function socialLogin(profile: SocialProfile, ctx: SessionContext, fallbackName?: string) {
  const lookup = () =>
    prisma.authAccount.findUnique({
      where: { provider_providerUserId: { provider: profile.provider, providerUserId: profile.providerUserId } },
      include: { user: { include: withAccounts } },
    });

  let user = (await lookup())?.user;
  if (!user) {
    try {
      user = await linkOrCreate(profile, fallbackName);
    } catch (err) {
      // Two first-time logins racing: the loser finds the winner's rows.
      if (!isUniqueViolation(err)) throw err;
      user = (await lookup())?.user;
      if (!user) throw err;
    }
  }
  assertCanSignIn(user);
  return startSession(user, ctx);
}

async function linkOrCreate(profile: SocialProfile, fallbackName?: string): Promise<UserWithAccounts> {
  const verifiedEmail = profile.emailVerified ? profile.email : undefined;

  return prisma.$transaction(async (tx) => {
    if (verifiedEmail) {
      const existing = await tx.user.findUnique({ where: { email: verifiedEmail } });
      if (existing) {
        if (!existing.emailVerifiedAt) {
          // Pre-hijacking defence: someone may have registered this address with a password of
          // their own *before* its real owner ever proved they hold it. Now the owner has (via the
          // provider), so drop that password and every session created with it.
          await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date(), passwordHash: null } });
          await tx.authAccount.deleteMany({ where: { userId: existing.id, provider: "EMAIL" } });
          await revokeAllForUser(existing.id, tx);
        }
        await tx.authAccount.create({
          data: { userId: existing.id, provider: profile.provider, providerUserId: profile.providerUserId },
        });
        return tx.user.findUniqueOrThrow({ where: { id: existing.id }, include: withAccounts });
      }
    }

    const name = (profile.name ?? fallbackName)?.trim() || verifiedEmail?.split("@")[0] || "Player";
    return tx.user.create({
      data: {
        name: name.slice(0, 80),
        email: verifiedEmail ?? null,
        emailVerifiedAt: verifiedEmail ? new Date() : null,
        avatarUrl: profile.picture ?? null,
        authAccounts: { create: { provider: profile.provider, providerUserId: profile.providerUserId } },
      },
      include: withAccounts,
    });
  });
}

// ─────────────────────────── phone OTP ───────────────────────────

const HOUR = 3_600_000;

/**
 * Texts a 6-digit code. Three brakes against abuse (an SMS costs real money and "SMS pumping" is a known fraud):
 * a cooldown between texts, a per-number hourly cap, and a global 24h ceiling (`SMS_DAILY_LIMIT`).
 * The reply is identical whether or not the number already has an account.
 */
export async function requestPhoneCode(phone: string) {
  if (!sms.enabled) throw new AppError(ErrorCode.AUTH_PROVIDER_NOT_CONFIGURED, 503, "Phone sign-in is not available");

  const sentToday = await prisma.verificationCode.count({ where: { type: "PHONE_OTP", createdAt: { gte: new Date(Date.now() - 24 * HOUR) } } });
  if (sentToday >= env.SMS_DAILY_LIMIT) {
    logger.error({ sentToday }, "daily SMS ceiling reached");
    throw new AppError(ErrorCode.AUTH_SMS_UNAVAILABLE, 503, "Sign-in by SMS is temporarily unavailable");
  }
  const lastHour = await prisma.verificationCode.count({ where: { type: "PHONE_OTP", target: phone, createdAt: { gte: new Date(Date.now() - HOUR) } } });
  if (lastHour >= OTP.phonePerHour) throw new AppError(ErrorCode.AUTH_OTP_LIMIT, 429, "Too many codes requested for this number; try again later");

  const { code, expiresMinutes } = await issueCode("PHONE_OTP", phone, { enforceCooldown: true });
  try {
    await sms.send(phone, `Your PlayerHaat code is ${code}. It expires in ${expiresMinutes} minutes. Don't share it with anyone.`);
  } catch (err) {
    // The text never left: forget the code so the user isn't made to wait out a cooldown for nothing.
    await prisma.verificationCode.deleteMany({ where: { type: "PHONE_OTP", target: phone, consumedAt: null } });
    throw err;
  }
}

/** Verify the code, then sign in the number's owner — creating the account if this is a new number. */
export async function phoneLogin(input: { phone: string; code: string; name?: string }, ctx: SessionContext) {
  await verifyCode("PHONE_OTP", input.phone, input.code);

  const lookup = () =>
    prisma.authAccount.findUnique({
      where: { provider_providerUserId: { provider: "PHONE", providerUserId: input.phone } },
      include: { user: { include: withAccounts } },
    });

  const existing = (await lookup())?.user;
  if (existing) {
    assertCanSignIn(existing);
    return { ...(await startSession(existing, ctx)), isNewUser: false };
  }

  let user: UserWithAccounts;
  try {
    user = await prisma.$transaction(async (tx) => {
      // Someone may have *typed* this number into their profile without ever verifying it. Proving
      // possession of the SIM beats a bare claim, so release the number from them.
      await tx.user.updateMany({ where: { phone: input.phone, phoneVerifiedAt: null }, data: { phone: null } });
      return tx.user.create({
        data: {
          name: input.name ?? "Player",
          phone: input.phone,
          phoneVerifiedAt: new Date(),
          authAccounts: { create: { provider: "PHONE", providerUserId: input.phone } },
        },
        include: withAccounts,
      });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await lookup())?.user; // two first logins for the same number racing
    if (!raced) throw err;
    assertCanSignIn(raced);
    return { ...(await startSession(raced, ctx)), isNewUser: false };
  }
  return { ...(await startSession(user, ctx)), isNewUser: true };
}
