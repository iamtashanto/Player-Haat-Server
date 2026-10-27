import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./billing.schema.js";
import * as svc from "./billing.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const checkoutLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 20 });
const submitLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 15 });

/** Mounted at /billing behind the app-user guard. */
export const billingRoutes = Router();
billingRoutes.get("/wallet", async (req, res) => ok(res, await svc.wallet(me(req))));
billingRoutes.get("/transactions", validate({ query: s.transactionsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.transactionsQuery>>(req);
  const { items, nextCursor } = await svc.transactions(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
billingRoutes.post("/checkout", checkoutLimiter, validate({ body: s.checkoutBody }), async (req, res) => {
  created(res, await svc.checkout(me(req), valid<B<typeof s.checkoutBody>>(req).body));
});
billingRoutes.post("/payments/:id/submit", submitLimiter, validate({ params: s.paymentParams, body: s.submitBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.submitBody>, B<typeof s.paymentParams>>(req);
  ok(res, await svc.submitPayment(me(req), params.id, body));
});
billingRoutes.get("/payments", async (req, res) => ok(res, await svc.myPayments(me(req))));
