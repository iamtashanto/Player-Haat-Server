import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";
import { phone } from "../users/users.schema.js";

const id = z.string().min(1).max(40);
export const METHODS = ["BKASH", "NAGAD", "ROCKET"] as const;

export const checkoutBody = z.strictObject({ packId: id, method: z.enum(METHODS) });
export const paymentParams = z.object({ id });
export const submitBody = z.strictObject({
  trxId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,24}$/, "The transaction id is 6–24 letters and digits")
    .openapi({ example: "9G7H2K4LMN" }),
  senderNumber: phone.openapi({ description: "The number you paid from." }),
});
export const transactionsQuery = pageQuery;

const Pack = z.object({ id: z.string(), code: z.string(), credits: z.number().int(), priceBdt: z.number().int() }).openapi("CreditPack");
const Pricing = z.object({ contactCreditsEnabled: z.boolean(), freeContactsPerDay: z.number().int(), contactCreditCost: z.number().int(), boostCreditCost: z.number().int(), boostHours: z.number().int() });
const Method = z.object({ method: z.enum(METHODS), payTo: z.string().nullable() });
const Payment = z
  .object({
    id: z.string(),
    status: z.enum(["PENDING", "SUBMITTED", "PAID", "REJECTED"]),
    method: z.enum(METHODS),
    credits: z.number().int(),
    amountBdt: z.number().int(),
    trxId: z.string().nullable(),
    payTo: z.string().nullable().openapi({ description: "Where to send the money. Only while the payment is waiting for you." }),
    reviewNote: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Payment");

const T = "Billing";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "get", path: "/billing/wallet", ...A, summary: "My credits, current prices and the ways I can pay", response: z.object({ balance: z.number().int(), pricing: Pricing, methods: z.array(Method), packs: z.array(Pack) }) });
registerRoute({ method: "get", path: "/billing/transactions", ...A, summary: "My credit history", query: transactionsQuery, response: z.array(z.object({ id: z.string(), delta: z.number().int(), balanceAfter: z.number().int(), reason: z.string(), createdAt: z.string().datetime() })), errors: [422] });
registerRoute({ method: "post", path: "/billing/checkout", ...A, summary: "Start buying a credit pack", description: "Mobile-banking top-up: send the amount to `payTo`, then submit the transaction id.", body: checkoutBody, response: Payment, status: 201, errors: [404, 409, 422, 503] });
registerRoute({ method: "post", path: "/billing/payments/{id}/submit", ...A, summary: "Submit the transaction id for a payment I made", description: "An admin checks it against the account's statement; credits are added on approval. A transaction id can only be used once.", params: paymentParams, body: submitBody, response: Payment, errors: [404, 409, 422] });
registerRoute({ method: "get", path: "/billing/payments", ...A, summary: "My payments", response: z.array(Payment) });
