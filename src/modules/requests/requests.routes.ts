import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./requests.schema.js";
import * as svc from "./requests.service.js";


const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, z.infer<typeof s.requestParams>>(req).params.id;

const createLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 20 });
const feedLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 120 });
const mutateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 60 });

export const requestsRoutes = Router();
requestsRoutes.use(requireAuth);

requestsRoutes.post("/", createLimiter, validate({ body: s.createRequestBody }), async (req, res) => {
  created(res, await svc.createRequest(me(req), valid<z.infer<typeof s.createRequestBody>>(req).body));
});

// "/mine" must be declared before "/:id".
requestsRoutes.get("/mine", validate({ query: s.mineQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.mineQuery>>(req);
  const { items, nextCursor } = await svc.myRequests(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
requestsRoutes.get("/", feedLimiter, validate({ query: s.feedQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.feedQuery>>(req);
  const { items, nextCursor } = await svc.feed(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
requestsRoutes.get("/:id", validate({ params: s.requestParams }), async (req, res) => ok(res, await svc.getRequest(me(req), idOf(req))));

requestsRoutes.patch("/:id", mutateLimiter, validate({ params: s.requestParams, body: s.updateRequestBody }), async (req, res) => {
  ok(res, await svc.updateRequest(me(req), idOf(req), valid<z.infer<typeof s.updateRequestBody>>(req).body));
});
requestsRoutes.post("/:id/cancel", mutateLimiter, validate({ params: s.requestParams }), async (req, res) => ok(res, await svc.cancelRequest(me(req), idOf(req))));
requestsRoutes.post("/:id/fill", mutateLimiter, validate({ params: s.requestParams }), async (req, res) => ok(res, await svc.fillRequest(me(req), idOf(req))));
requestsRoutes.post("/:id/complete", mutateLimiter, validate({ params: s.requestParams }), async (req, res) => ok(res, await svc.completeRequest(me(req), idOf(req))));
