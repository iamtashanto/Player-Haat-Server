import { SignJWT, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { decryptSecret, encryptSecret, generateSecret, hashBackupCode, newBackupCodes, otpauthUrl, verifyCode } from "../../lib/totp.js";
import { startAdminSession } from "../auth/auth.service.js";
import type { SessionContext } from "../auth/token.service.js";

/**
 * Admin sign-in is two steps: password → a short-lived *challenge* → a TOTP (or backup) code → a session. The challenge
 * is signed with its own issuer, so it can never be mistaken for an access token even though they share a key.
 */
const ISSUER = "playerhaat-admin-2fa";
const secretKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const CHALLENGE_TTL = "5m";

export type Challenge = { status: "TOTP_REQUIRED" | "TOTP_SETUP_REQUIRED"; challengeToken: string };

const sign = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(ISSUER).setIssuedAt().setExpirationTime(CHALLENGE_TTL).sign(secretKey);

export async function beginChallenge(user: { id: string; totpEnabledAt: Date | null }): Promise<Challenge> {
  return { status: user.totpEnabledAt ? "TOTP_REQUIRED" : "TOTP_SETUP_REQUIRED", challengeToken: await sign(user.id) };
}

/** The admin a challenge belongs to, or 401. Expired, forged and wrong-purpose tokens all look the same. */
async function adminFromChallenge(token: string) {
  let sub: string | undefined;
  try {
    ({ payload: { sub } } = await jwtVerify(token, secretKey, { issuer: ISSUER, algorithms: ["HS256"] }));
  } catch {
    throw AppError.unauthorized("AUTH_CHALLENGE_INVALID", "This sign-in step expired. Start again.");
  }
  const user = sub ? await prisma.user.findUnique({ where: { id: sub }, include: { authAccounts: { select: { provider: true } } } }) : null;
  if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") throw AppError.unauthorized("AUTH_CHALLENGE_INVALID", "This sign-in step expired. Start again.");
  return user;
}

const wrongCode = () => AppError.unauthorized("AUTH_INVALID_TOTP", "That code isn't right");

/** Step 2a (first time): make a secret for the authenticator app. It stays pending until a code proves it works. */
export async function startSetup(challengeToken: string) {
  const user = await adminFromChallenge(challengeToken);
  if (user.totpEnabledAt) throw AppError.conflict("AUTH_TOTP_ALREADY_ENABLED", "Two-factor is already set up for this account");
  const secret = generateSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret) } });
  return { secret, otpauthUrl: otpauthUrl(secret, user.email ?? user.id) };
}

/** Step 2b (first time): the first valid code turns 2FA on, hands out backup codes once, and signs in. */
export async function enable(challengeToken: string, code: string, ctx: SessionContext) {
  const user = await adminFromChallenge(challengeToken);
  if (user.totpEnabledAt) throw AppError.conflict("AUTH_TOTP_ALREADY_ENABLED", "Two-factor is already set up for this account");
  if (!user.totpSecret) throw AppError.conflict("AUTH_TOTP_NOT_STARTED", "Start the setup first");
  const step = verifyCode(decryptSecret(user.totpSecret), code);
  if (step === null) throw wrongCode();
  const backupCodes = newBackupCodes();
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, totpEnabledAt: null }, // compare-and-set: a double submit can't enable (and mint codes) twice
    data: { totpEnabledAt: new Date(), totpLastStep: step, totpBackupHashes: backupCodes.map(hashBackupCode) },
  });
  if (claimed.count === 0) throw AppError.conflict("AUTH_TOTP_ALREADY_ENABLED", "Two-factor is already set up for this account");
  const session = await startAdminSession(user, ctx);
  return { session, backupCodes };
}

/** Step 2 (every later sign-in): a current code, or one of the backup codes (each works once). */
export async function verify(challengeToken: string, input: { code?: string; backupCode?: string }, ctx: SessionContext) {
  const user = await adminFromChallenge(challengeToken);
  if (!user.totpEnabledAt || !user.totpSecret) throw AppError.conflict("AUTH_TOTP_NOT_STARTED", "Set up two-factor first");

  if (input.code) {
    const step = verifyCode(decryptSecret(user.totpSecret), input.code, { after: user.totpLastStep });
    if (step === null) throw wrongCode();
    // Only the first of two simultaneous submissions of the same code gets in.
    const claimed = await prisma.user.updateMany({ where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
    if (claimed.count === 0) throw wrongCode();
  } else if (input.backupCode) {
    const hash = hashBackupCode(input.backupCode);
    if (!user.totpBackupHashes.includes(hash)) throw wrongCode();
    const claimed = await prisma.user.updateMany({ where: { id: user.id, totpBackupHashes: { has: hash } }, data: { totpBackupHashes: user.totpBackupHashes.filter((h) => h !== hash) } });
    if (claimed.count === 0) throw wrongCode(); // already spent a moment ago
  } else {
    throw AppError.invalid("code", "Enter your 6-digit code or a backup code");
  }
  return startAdminSession(user, ctx);
}

/** A fresh set of backup codes (the old ones stop working). Needs a current code, not just a session. */
export async function regenerateBackupCodes(adminId: string, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  if (!user.totpEnabledAt || !user.totpSecret) throw AppError.conflict("AUTH_TOTP_NOT_STARTED", "Set up two-factor first");
  const step = verifyCode(decryptSecret(user.totpSecret), code, { after: user.totpLastStep });
  if (step === null) throw wrongCode();
  const codes = newBackupCodes();
  await prisma.user.update({ where: { id: adminId }, data: { totpLastStep: step, totpBackupHashes: codes.map(hashBackupCode) } });
  return { backupCodes: codes };
}

/** Signed-in sessions (one per login), so a lost laptop can be signed out remotely. */
export async function listSessions(adminId: string) {
  const rows = await prisma.refreshToken.findMany({ where: { userId: adminId, revokedAt: null, expiresAt: { gt: new Date() }, replacedById: null }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((r) => ({ id: r.familyId, device: r.deviceId, userAgent: r.userAgent, signedInAt: r.createdAt.toISOString() }));
}

export async function revokeSession(adminId: string, familyId: string) {
  const { count } = await prisma.refreshToken.updateMany({ where: { userId: adminId, familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count === 0) throw AppError.notFound("SESSION_NOT_FOUND", "That session isn't active");
  return { revoked: true };
}

