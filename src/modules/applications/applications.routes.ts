import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./applications.schema.js";
import * as svc from "./applications.service.js";

const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const applyLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });
const actLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 120 });
const appId = (req: Parameters<typeof valid>[0]) => valid<unknown, z.infer<typeof s.applicationParams>>(req).params.id;

/** Mounted at /requests/:requestId/applications */
export const requestApplicationsRoutes = Router({ mergeParams: true });
requestApplicationsRoutes.use(requireAuth);

requestApplicationsRoutes.post("/", applyLimiter, validate({ params: s.requestIdParams, body: s.applyBody }), async (req, res) => {
  const { params, body } = valid<z.infer<typeof s.applyBody>, z.infer<typeof s.requestIdParams>>(req);
  created(res, await svc.apply(me(req), params.requestId, body));
});
requestApplicationsRoutes.get("/", validate({ params: s.requestIdParams, query: s.applicantsQuery }), async (req, res) => {
  const { params, query } = valid<unknown, z.infer<typeof s.requestIdParams>, z.infer<typeof s.applicantsQuery>>(req);
  const { items, nextCursor } = await svc.listApplicants(me(req), params.requestId, query);
  ok(res, items, { nextCursor, limit: query.limit });
});

/** Mounted at /applications */
export const applicationsRoutes = Router();
applicationsRoutes.use(requireAuth);

applicationsRoutes.get("/mine", validate({ query: s.myApplicationsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.myApplicationsQuery>>(req);
  const { items, nextCursor } = await svc.myApplications(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
applicationsRoutes.post("/:id/accept", actLimiter, validate({ params: s.applicationParams }), async (req, res) => ok(res, await svc.accept(me(req), appId(req))));
applicationsRoutes.post("/:id/reject", actLimiter, validate({ params: s.applicationParams }), async (req, res) => ok(res, await svc.reject(me(req), appId(req))));
applicationsRoutes.post("/:id/withdraw", actLimiter, validate({ params: s.applicationParams }), async (req, res) => ok(res, await svc.withdraw(me(req), appId(req))));
