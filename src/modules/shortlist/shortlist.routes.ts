import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { authUser, requireRole } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { requireOnboardedRecruiter } from "../recruiters/recruiters.service.js";
import * as s from "./shortlist.schema.js";
import * as svc from "./shortlist.service.js";

type B<T extends z.ZodType> = z.infer<T>;
const me = (req: Parameters<typeof authUser>[0]) => authUser(req).userId;

/** Mounted at /shortlist behind the app-user guard; recruiters only. */
export const shortlistRoutes = Router();
shortlistRoutes.use(requireRole("RECRUITER"), requireOnboardedRecruiter);

shortlistRoutes.get("/", validate({ query: s.shortlistQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, B<typeof s.shortlistQuery>>(req);
  const { items, nextCursor } = await svc.list(me(req), query);
  ok(res, items, { nextCursor, limit: query.limit });
});
shortlistRoutes.put("/:profileId", validate({ params: s.profileParams, body: s.saveBody }), async (req, res) => {
  const { params, body } = valid<B<typeof s.saveBody>, B<typeof s.profileParams>>(req);
  ok(res, await svc.save(me(req), params.profileId, body));
});
shortlistRoutes.delete("/:profileId", validate({ params: s.profileParams }), async (req, res) => {
  ok(res, await svc.remove(me(req), valid<unknown, B<typeof s.profileParams>>(req).params.profileId));
});
