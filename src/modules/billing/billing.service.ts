import type { Payment, PaymentMethod, Prisma } from "@prisma/client";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { getPricing } from "../app-config/app-config.service.js";
import type { checkoutBody, submitBody, transactionsQuery } from "./billing.schema.js";
import { grantCredits } from "./credits.service.js";

const MAX_OPEN_PAYMENTS = 3;

/** Where users send money for each method; a method with no number configured isn't offered. */
const PAY_TO: Record<Exclude<PaymentMethod, "SANDBOX">, string | undefined> = {
  BKASH: env.PAYMENT_BKASH_NUMBER,
  NAGAD: env.PAYMENT_NAGAD_NUMBER,
  ROCKET: env.PAYMENT_ROCKET_NUMBER,
};

export function availableMethods(): Array<{ method: PaymentMethod; payTo: string | null }> {
  const real = (Object.entries(PAY_TO) as Array<[Exclude<PaymentMethod, "SANDBOX">, string | undefined]>).filter(([, n]) => n).map(([method, n]) => ({ method, payTo: n! }));
  // Sandbox pays instantly, so it must never exist where real money does.
  return env.isProd ? real : [...real, { method: "SANDBOX" as const, payTo: null }];
}

export const listPacks = () => prisma.creditPack.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { priceBdt: "asc" }], select: { id: true, code: true, credits: true, priceBdt: true } });

export function toPayment(p: Payment) {
  const waiting = p.status === "PENDING" && p.method !== "SANDBOX";
  return {
    id: p.id,
    status: p.status,
    method: p.method,
    credits: p.credits,
    amountBdt: p.amountBdt,
    trxId: p.trxId,
    payTo: waiting && p.method !== "SANDBOX" ? (PAY_TO[p.method] ?? null) : null,
    reviewNote: p.reviewNote,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function wallet(userId: string) {
  const [user, pricing, packs] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } }), getPricing(), listPacks()]);
  return { balance: user.creditBalance, pricing, methods: availableMethods(), packs };
}

export async function transactions(userId: string, q: z.infer<typeof transactionsQuery>) {
  const rows = await prisma.creditTransaction.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map((t) => ({ id: t.id, delta: t.delta, balanceAfter: t.balanceAfter, reason: t.reason, createdAt: t.createdAt.toISOString() })), nextCursor };
}

export async function checkout(userId: string, input: z.infer<typeof checkoutBody>) {
  const pack = await prisma.creditPack.findFirst({ where: { id: input.packId, isActive: true } });
  if (!pack) throw AppError.notFound("CREDIT_PACK_NOT_FOUND", "That pack isn't available");
  if (!availableMethods().some((m) => m.method === input.method)) {
    throw new AppError("PAYMENT_METHOD_UNAVAILABLE", 503, "That payment method isn't available right now");
  }
  const open = await prisma.payment.count({ where: { userId, status: { in: ["PENDING", "SUBMITTED"] } } });
  if (open >= MAX_OPEN_PAYMENTS) throw AppError.conflict("PAYMENT_TOO_MANY_OPEN", "Finish or wait for your open payments first");

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({ data: { userId, packId: pack.id, credits: pack.credits, amountBdt: pack.priceBdt, method: input.method } });
    if (input.method !== "SANDBOX") return toPayment(payment);
    await grantCredits(tx, userId, payment.credits, "PURCHASE", { refType: "Payment", refId: payment.id });
    return toPayment(await tx.payment.update({ where: { id: payment.id }, data: { status: "PAID", reviewedAt: new Date(), reviewNote: "Sandbox" } }));
  });
}

export async function submitPayment(userId: string, id: string, input: z.infer<typeof submitBody>) {
  const p = await prisma.payment.findFirst({ where: { id, userId } });
  if (!p) throw AppError.notFound("PAYMENT_NOT_FOUND", "Payment not found");
  if (p.method === "SANDBOX") throw AppError.conflict("PAYMENT_NOT_SUBMITTABLE", "Nothing to submit for this payment");
  if (p.status !== "PENDING") throw AppError.conflict("PAYMENT_NOT_SUBMITTABLE", `This payment is already ${p.status.toLowerCase()}`);
  try {
    return toPayment(await prisma.payment.update({ where: { id }, data: { status: "SUBMITTED", trxId: input.trxId, senderNumber: input.senderNumber } }));
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") throw AppError.conflict("PAYMENT_TRX_USED", "That transaction id has already been used");
    throw err;
  }
}

export async function myPayments(userId: string) {
  const rows = await prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map(toPayment);
}
