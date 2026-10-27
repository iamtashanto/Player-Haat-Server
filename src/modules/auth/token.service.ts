import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, UserRole } from "@prisma/client";
import { env } from "../../config/env.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { signAccessToken } from "../../lib/jwt.js";
import { prisma } from "../../lib/prisma.js";
import { REFRESH_REUSE_MESSAGE } from "./auth.constants.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface SessionContext {
  deviceId?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  refreshExpiresAt: string;
}

async function mint(
  db: Db,
  user: { id: string; role: UserRole },
  familyId: string,
  ctx: SessionContext,
): Promise<{ id: string; tokens: AuthTokens }> {
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const row = await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(raw), // only the hash is stored
      familyId,
      deviceId: ctx.deviceId,
      userAgent: ctx.userAgent?.slice(0, 255),
      expiresAt,
    },
    select: { id: true },
  });
  return {
    id: row.id,
    tokens: {
      accessToken: await signAccessToken({ userId: user.id, role: user.role }),
      refreshToken: raw,
      tokenType: "Bearer",
      expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
      refreshExpiresAt: expiresAt.toISOString(),
    },
  };
}

/** "Recently active" sorting in player search: a login or token refresh counts as activity. */
const touchLastActive = (userId: string) =>
  prisma.playerProfile.updateMany({ where: { userId }, data: { lastActiveAt: new Date() } }).catch(() => undefined);

/** Starts a brand-new session (a new refresh-token family) after a successful login. */
export async function issueTokens(
  user: { id: string; role: UserRole },
  ctx: SessionContext,
  db: Db = prisma,
): Promise<AuthTokens> {
  const { tokens } = await mint(db, user, randomUUID(), ctx);
  await touchLastActive(user.id);
  return tokens;
}

export const revokeFamily = (familyId: string, db: Db = prisma) =>
  db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });

export const revokeAllForUser = (userId: string, db: Db = prisma) =>
  db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

/**
 * Rotation with reuse detection.
 * Every refresh consumes the presented token and issues a successor in the same family.
 * Presenting an already-consumed token means it was stolen or replayed, so the whole family
 * (every descendant, including the legitimate holder's current token) is revoked.
 *
 * Clients must therefore serialize refreshes (single-flight): two parallel refreshes with the
 * same token look identical to a replay attack and will log the user out.
 */
export async function rotateRefreshToken(raw: string, ctx: SessionContext): Promise<AuthTokens> {
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(raw) },
    include: { user: { select: { id: true, role: true, status: true } } },
  });
  if (!existing) throw AppError.unauthorized(ErrorCode.AUTH_INVALID_REFRESH_TOKEN);

  if (existing.revokedAt) {
    if (existing.replacedById) await revokeFamily(existing.familyId); // consumed by rotation → replay
    throw existing.replacedById
      ? new AppError(ErrorCode.AUTH_REFRESH_REUSED, 401, REFRESH_REUSE_MESSAGE)
      : AppError.unauthorized(ErrorCode.AUTH_INVALID_REFRESH_TOKEN); // revoked by logout
  }
  if (existing.expiresAt <= new Date()) throw AppError.unauthorized(ErrorCode.AUTH_REFRESH_EXPIRED);

  if (existing.user.status === "SUSPENDED") {
    await revokeFamily(existing.familyId);
    throw AppError.forbidden(ErrorCode.AUTH_ACCOUNT_SUSPENDED);
  }
  if (existing.user.status === "DELETED") {
    await revokeFamily(existing.familyId);
    throw AppError.unauthorized(ErrorCode.AUTH_INVALID_REFRESH_TOKEN);
  }

  const rotated = await prisma.$transaction(async (tx) => {
    // Compare-and-set: of two concurrent requests with the same token, exactly one wins.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    const next = await mint(tx, existing.user, existing.familyId, {
      deviceId: existing.deviceId ?? ctx.deviceId,
      userAgent: ctx.userAgent,
    });
    await tx.refreshToken.update({ where: { id: existing.id }, data: { replacedById: next.id } });
    return next.tokens;
  });

  if (!rotated) {
    await revokeFamily(existing.familyId);
    throw new AppError(ErrorCode.AUTH_REFRESH_REUSED, 401, REFRESH_REUSE_MESSAGE);
  }
  await touchLastActive(existing.user.id);
  return rotated;
}

/** Logout this device: revoke the family the token belongs to. Idempotent; unknown tokens are ignored. */
export async function logout(raw: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, select: { familyId: true } });
  if (row) await revokeFamily(row.familyId);
}
