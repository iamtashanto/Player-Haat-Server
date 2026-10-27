import type { CreditReason, Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors.js";

type Tx = Prisma.TransactionClient;

export interface LedgerRef {
  refType?: string;
  refId?: string;
}

/**
 * The only place a credit balance changes. The balance moves with a single conditional UPDATE, so it can't go
 * below zero even when two spends race (the loser gets nothing), and the ledger row records the result in the
 * same transaction. `User.creditBalance` is therefore always the sum of that user's ledger.
 */
async function move(tx: Tx, userId: string, delta: number, reason: CreditReason, ref: LedgerRef = {}) {
  if (!Number.isInteger(delta) || delta === 0) throw new Error("credit delta must be a non-zero integer");
  const rows = await tx.$queryRaw<{ creditBalance: number }[]>`
    UPDATE "User" SET "creditBalance" = "creditBalance" + ${delta}
    WHERE id = ${userId} AND "creditBalance" + ${delta} >= 0
    RETURNING "creditBalance"`;
  if (rows.length === 0) {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { creditBalance: true } });
    if (!u) throw AppError.notFound("USER_NOT_FOUND", "User not found");
    throw new AppError("CREDITS_REQUIRED", 402, "Not enough credits", { balance: u.creditBalance, needed: -delta });
  }
  const balanceAfter = rows[0]!.creditBalance;
  await tx.creditTransaction.create({ data: { userId, delta, balanceAfter, reason, refType: ref.refType ?? null, refId: ref.refId ?? null } });
  return balanceAfter;
}

export const grantCredits = (tx: Tx, userId: string, amount: number, reason: CreditReason, ref?: LedgerRef) => move(tx, userId, Math.abs(amount), reason, ref);
export const spendCredits = (tx: Tx, userId: string, amount: number, reason: CreditReason, ref?: LedgerRef) => move(tx, userId, -Math.abs(amount), reason, ref);
/** Admin adjustment in either direction. */
export const adjustCredits = (tx: Tx, userId: string, delta: number, reason: CreditReason, ref?: LedgerRef) => move(tx, userId, delta, reason, ref);
