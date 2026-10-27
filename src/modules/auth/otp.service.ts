import type { VerificationType } from "@prisma/client";
import { hashCode, randomNumericCode, safeEqual } from "../../lib/crypto.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { OTP } from "./auth.constants.js";

const scope = (type: VerificationType, target: string) => `${type}:${target}`;

/**
 * Creates a fresh code for (type, target) and invalidates earlier unused ones, so only the
 * newest email is ever valid. With `enforceCooldown`, throws AUTH_OTP_COOLDOWN if a code was
 * issued less than OTP.cooldownSec ago (stops email-bombing through "resend").
 */
export async function issueCode(
  type: VerificationType,
  target: string,
  opts: { userId?: string; enforceCooldown?: boolean } = {},
): Promise<{ code: string; expiresMinutes: number }> {
  if (opts.enforceCooldown) {
    const last = await prisma.verificationCode.findFirst({
      where: { type, target },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < OTP.cooldownSec * 1000) {
      throw new AppError(ErrorCode.AUTH_OTP_COOLDOWN, 429, `Wait ${OTP.cooldownSec}s before requesting another code`);
    }
  }

  const code = randomNumericCode(OTP.digits);
  const expiresMinutes = OTP.ttlMinutes[type];
  await prisma.$transaction([
    prisma.verificationCode.updateMany({
      where: { type, target, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.verificationCode.create({
      data: {
        type,
        target,
        userId: opts.userId,
        codeHash: hashCode(scope(type, target), code),
        expiresAt: new Date(Date.now() + expiresMinutes * 60 * 1000),
      },
    }),
  ]);
  return { code, expiresMinutes };
}

/**
 * Checks `code` against the newest unused code. The attempt counter is incremented *before*
 * comparing (atomically in SQL) so parallel guesses can't exceed the budget. A correct code is
 * consumed with a compare-and-set so it can only ever be used once.
 */
export async function verifyCode(type: VerificationType, target: string, code: string): Promise<void> {
  const record = await prisma.verificationCode.findFirst({
    where: { type, target, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!record) throw AppError.badRequest(ErrorCode.AUTH_INVALID_OTP, "Invalid code");
  if (record.expiresAt <= new Date()) throw AppError.badRequest(ErrorCode.AUTH_OTP_EXPIRED, "Code expired");

  const { attempts } = await prisma.verificationCode.update({
    where: { id: record.id },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  if (attempts > OTP.maxAttempts) {
    throw new AppError(ErrorCode.AUTH_OTP_TOO_MANY_ATTEMPTS, 429, "Too many attempts; request a new code");
  }

  if (!safeEqual(record.codeHash, hashCode(scope(type, target), code))) {
    throw AppError.badRequest(ErrorCode.AUTH_INVALID_OTP, "Invalid code");
  }

  const consumed = await prisma.verificationCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) throw AppError.badRequest(ErrorCode.AUTH_INVALID_OTP, "Invalid code");
}
