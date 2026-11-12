import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as s from "./series.schema.js";
import * as svc from "./series.service.js";

const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;
const idOf = (req: Parameters<typeof valid>[0]) => valid<unknown, z.infer<typeof s.seriesParams>>(req).params.id;
const mutateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 60 });

/** Mounted at /series behind the app-user guard. */
export const seriesRoutes = Router();

seriesRoutes.post("/from-request/:requestId", mutateLimiter, validate({ params: s.repeatParams, body: s.repeatBody }), async (req, res) => {
  const { params, body } = valid<z.infer<typeof s.repeatBody>, z.infer<typeof s.repeatParams>>(req);
  created(res, await svc.fromRequest(me(req), params.requestId, body.title));
});
// Static paths before "/:id".
seriesRoutes.get("/mine", async (req, res) => ok(res, await svc.mine(me(req))));
seriesRoutes.get("/:id", validate({ params: s.seriesParams }), async (req, res) => ok(res, await svc.get(me(req), idOf(req))));
seriesRoutes.patch("/:id", mutateLimiter, validate({ params: s.seriesParams, body: s.updateSeriesBody }), async (req, res) => ok(res, await svc.update(me(req), idOf(req), valid<z.infer<typeof s.updateSeriesBody>>(req).body)));
seriesRoutes.post("/:id/regulars", mutateLimiter, validate({ params: s.seriesParams }), async (req, res) => ok(res, await svc.becomeRegular(me(req), idOf(req))));
seriesRoutes.delete("/:id/regulars", mutateLimiter, validate({ params: s.seriesParams }), async (req, res) => ok(res, await svc.leaveRegulars(me(req), idOf(req))));
