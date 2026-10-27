import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth, requireRole } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as billing from "../billing/billing.admin.js";
import * as chat from "../chat/chat.service.js";
import * as verification from "../verification/verification.service.js";
import * as vs from "../verification/verification.schema.js";
import { registerRoute } from "../../lib/openapi.js";
import { z as zod } from "../../lib/zod.js";

type B<T extends z.ZodType> = z.infer<T>;
const adminId = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, { id: string }>(req).params.id;
const idParams = zod.object({ id: zod.string().min(1).max(40) });

/**
 * Admin endpoints for verification, payments, credits and chat reports. Kept in their own router (mounted at
 * /admin next to the main one) so the moderation core stays small; the guard is the same: signed-in ADMIN only.
 */
export const adminExtraRoutes = Router();
adminExtraRoutes.use(requireAuth, requireRole("ADMIN"), createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 600 }));

// verification queue (recruiters + player stats)
adminExtraRoutes.get("/verifications", validate({ query: vs.adminQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof vs.adminQuery>>(req);
  const { items, nextCursor } = await verification.adminList(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminExtraRoutes.post("/verifications/:id/review", validate({ params: vs.verificationParams, body: vs.reviewBody }), async (req, res) => {
  ok(res, await verification.adminReview(adminId(req), idOf(req), valid<B<typeof vs.reviewBody>>(req).body));
});

// payments
adminExtraRoutes.get("/payments", validate({ query: billing.paymentsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof billing.paymentsQuery>>(req);
  const { items, nextCursor } = await billing.listPayments(query);
  ok(res, items, { nextCursor, limit: query.limit });
});
adminExtraRoutes.post("/payments/:id/approve", validate({ params: idParams }), async (req, res) => ok(res, await billing.approvePayment(adminId(req), idOf(req))));
adminExtraRoutes.post("/payments/:id/reject", validate({ params: idParams, body: billing.rejectBody }), async (req, res) => ok(res, await billing.rejectPayment(adminId(req), idOf(req), valid<B<typeof billing.rejectBody>>(req).body.note)));

// credits + packs
adminExtraRoutes.post("/users/:id/credits", validate({ params: idParams, body: billing.grantBody }), async (req, res) => {
  const body = valid<B<typeof billing.grantBody>>(req).body;
  ok(res, await billing.grant(adminId(req), idOf(req), body.delta, body.reason));
});
adminExtraRoutes.get("/credit-packs", async (_req, res) => ok(res, await billing.listAllPacks()));
adminExtraRoutes.post("/credit-packs", validate({ body: billing.packBody }), async (req, res) => created(res, await billing.createPack(adminId(req), valid<B<typeof billing.packBody>>(req).body)));
adminExtraRoutes.put("/credit-packs/:id", validate({ params: idParams, body: billing.packUpdateBody }), async (req, res) => ok(res, await billing.updatePack(adminId(req), idOf(req), valid<B<typeof billing.packUpdateBody>>(req).body)));

// private messages: readable only through this endpoint, and every read is audit-logged
adminExtraRoutes.get("/conversations/:id/transcript", validate({ params: idParams }), async (req, res) => ok(res, await chat.transcriptForAdmin(adminId(req), idOf(req))));

// ── OpenAPI ──
const Obj = zod.record(zod.string(), zod.unknown());
const A = { tag: "Admin", auth: true } as const;
registerRoute({ method: "get", path: "/admin/verifications", ...A, summary: "Verification queue (recruiters and player stats)", description: "Pending first, oldest first, with the evidence and what's being vouched for.", query: vs.adminQuery, response: zod.array(Obj), errors: [403, 422] });
registerRoute({ method: "post", path: "/admin/verifications/{id}/review", ...A, summary: "Approve or reject a verification", description: "Approving adds the recruiter's verified badge, or marks the sport profile's stats verified. The submitter is notified.", params: vs.verificationParams, body: vs.reviewBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/admin/payments", ...A, summary: "Credit top-ups to review", description: "Defaults to SUBMITTED (the user paid and sent a transaction id), oldest first.", query: billing.paymentsQuery, response: zod.array(Obj), errors: [403, 422] });
registerRoute({ method: "post", path: "/admin/payments/{id}/approve", ...A, summary: "Confirm a payment and add the credits", description: "Check the transaction id and amount against the mobile-banking statement first. Idempotent: a payment can only ever be credited once.", params: idParams, response: Obj, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/admin/payments/{id}/reject", ...A, summary: "Reject a payment", params: idParams, body: billing.rejectBody, response: Obj, errors: [403, 404, 409, 422] });
registerRoute({ method: "post", path: "/admin/users/{id}/credits", ...A, summary: "Add or remove credits by hand", description: "Positive grants (support, promotions), negative takes back (refund). A balance can't go below zero.", params: idParams, body: billing.grantBody, response: Obj, errors: [402, 403, 404, 422] });
registerRoute({ method: "get", path: "/admin/credit-packs", ...A, summary: "All credit packs, including inactive", response: zod.array(Obj), errors: [403] });
registerRoute({ method: "post", path: "/admin/credit-packs", ...A, summary: "Create a credit pack", body: billing.packBody, response: Obj, status: 201, errors: [403, 409, 422] });
registerRoute({ method: "put", path: "/admin/credit-packs/{id}", ...A, summary: "Change a pack's price, size or availability", description: "Past payments keep the credits and price they were bought at.", params: idParams, body: billing.packUpdateBody, response: Obj, errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/admin/conversations/{id}/transcript", ...A, summary: "Read a reported conversation", description: "For moderation only. Every read is written to the audit log.", params: idParams, response: Obj, errors: [403, 404] });
