import type { Prisma } from "@prisma/client";
import { z } from "../../lib/zod.js";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, pageQuery, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifier.js";
import { adjustCredits, grantCredits } from "./credits.service.js";

// ───────── schemas ─────────
const reason = z.string().trim().min(3).max(300);
export const paymentsQuery = pageQuery.extend({ status: z.enum(["PENDING", "SUBMITTED", "PAID", "REJECTED", "ALL"]).default("SUBMITTED") });
export const rejectBody = z.strictObject({ note: reason });
export const grantBody = z.strictObject({ delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 10_000, "A non-zero amount up to 10,000"), reason });
const packFields = {
  credits: z.number().int().min(1).max(100_000),
  priceBdt: z.number().int().min(1).max(1_000_000),
  isActive: z.boolean(),
  order: z.number().int().min(0).max(1000),
};
export const packBody = z.strictObject({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, "2–20 letters, digits or _"),
  ...packFields,
  isActive: packFields.isActive.default(true),
  order: packFields.order.default(0),
});
// A separate schema with no defaults: a partial of packBody would quietly reset isActive/order on every edit.
export const packUpdateBody = z.strictObject(packFields).partial().refine((b) => Object.keys(b).length > 0, "Send at least one field");

const audit = (tx: Prisma.TransactionClient, adminId: string, action: "PAYMENT_APPROVE" | "PAYMENT_REJECT" | "CREDITS_GRANT" | "CREDIT_PACK_SET", targetType: string, targetId: string, why?: string | null, metadata?: Prisma.InputJsonObject) =>
  tx.adminAction.create({ data: { adminId, action, targetType, targetId, reason: why ?? null, metadata } });

// ───────── payments ─────────
const paymentInclude = { user: { select: { id: true, name: true, email: true, phone: true } }, pack: { select: { code: true } } } satisfies Prisma.PaymentInclude;
const toAdminPayment = (p: Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>) => ({
  id: p.id, status: p.status, method: p.method, packCode: p.pack.code, credits: p.credits, amountBdt: p.amountBdt,
  trxId: p.trxId, senderNumber: p.senderNumber, reviewNote: p.reviewNote, user: p.user, createdAt: p.createdAt.toISOString(), reviewedAt: p.reviewedAt?.toISOString() ?? null,
});

export async function listPayments(q: z.infer<typeof paymentsQuery>) {
  const rows = await prisma.payment.findMany({
    where: q.status === "ALL" ? {} : { status: q.status },
    include: paymentInclude,
    orderBy: q.status === "SUBMITTED" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toAdminPayment), nextCursor };
}

export async function approvePayment(adminId: string, id: string) {
  const p = await prisma.payment.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!p) throw AppError.notFound("PAYMENT_NOT_FOUND", "Payment not found");
  if (p.status !== "SUBMITTED") throw AppError.conflict("PAYMENT_NOT_REVIEWABLE", `This payment is ${p.status.toLowerCase()}; only submitted ones can be approved`);

  const row = await prisma.$transaction(async (tx) => {
    // Compare-and-set: two admins (or a double click) can never credit the same payment twice.
    const { count } = await tx.payment.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "PAID", reviewedById: adminId, reviewedAt: new Date() } });
    if (count === 0) throw AppError.conflict("PAYMENT_NOT_REVIEWABLE", "Someone else just reviewed this payment");
    const paid = await tx.payment.findUniqueOrThrow({ where: { id }, include: paymentInclude });
    await grantCredits(tx, paid.userId, paid.credits, "PURCHASE", { refType: "Payment", refId: id });
    await audit(tx, adminId, "PAYMENT_APPROVE", "PAYMENT", id, null, { credits: paid.credits, amountBdt: paid.amountBdt, trxId: paid.trxId });
    return paid;
  });
  notify({ userIds: [row.user.id], type: "SYSTEM", data: { paymentId: id }, params: { code: "PAYMENT_APPROVED" } });
  return toAdminPayment(row);
}

export async function rejectPayment(adminId: string, id: string, note: string) {
  const p = await prisma.payment.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!p) throw AppError.notFound("PAYMENT_NOT_FOUND", "Payment not found");
  if (p.status !== "SUBMITTED") throw AppError.conflict("PAYMENT_NOT_REVIEWABLE", `This payment is ${p.status.toLowerCase()}; only submitted ones can be rejected`);
  const row = await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "REJECTED", reviewedById: adminId, reviewedAt: new Date(), reviewNote: note } });
    if (count === 0) throw AppError.conflict("PAYMENT_NOT_REVIEWABLE", "Someone else just reviewed this payment");
    await audit(tx, adminId, "PAYMENT_REJECT", "PAYMENT", id, note);
    return tx.payment.findUniqueOrThrow({ where: { id }, include: paymentInclude });
  });
  notify({ userIds: [row.user.id], type: "SYSTEM", data: { paymentId: id }, params: { code: "PAYMENT_REJECTED" } });
  return toAdminPayment(row);
}

// ───────── credits ─────────
export async function grant(adminId: string, userId: string, delta: number, why: string) {
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw AppError.notFound("USER_NOT_FOUND", "User not found");
  return prisma.$transaction(async (tx) => {
    const balance = await adjustCredits(tx, userId, delta, delta > 0 ? "ADMIN_GRANT" : "REFUND", { refType: "Admin", refId: adminId });
    await audit(tx, adminId, "CREDITS_GRANT", "USER", userId, why, { delta });
    return { userId, balance };
  });
}

// ───────── packs ─────────
export const listAllPacks = () => prisma.creditPack.findMany({ orderBy: [{ order: "asc" }, { priceBdt: "asc" }] });

export async function createPack(adminId: string, input: z.infer<typeof packBody>) {
  try {
    return await prisma.$transaction(async (tx) => {
      const pack = await tx.creditPack.create({ data: input });
      await audit(tx, adminId, "CREDIT_PACK_SET", "CREDIT_PACK", pack.id, null, { created: input.code });
      return pack;
    });
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") throw AppError.conflict("CREDIT_PACK_EXISTS", "A pack with that code already exists");
    throw err;
  }
}

/** Past payments keep the credits and price they were bought at, so editing a pack never rewrites history. */
export async function updatePack(adminId: string, id: string, patch: z.infer<typeof packUpdateBody>) {
  if (!(await prisma.creditPack.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("CREDIT_PACK_NOT_FOUND", "Pack not found");
  return prisma.$transaction(async (tx) => {
    const pack = await tx.creditPack.update({ where: { id }, data: patch });
    await audit(tx, adminId, "CREDIT_PACK_SET", "CREDIT_PACK", id, null, patch);
    return pack;
  });
}
