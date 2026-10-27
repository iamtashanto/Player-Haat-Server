import { Router } from "express";
import { ok, valid } from "../../lib/http.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { cacheReference } from "../../middlewares/cache.js";
import { validate } from "../../middlewares/validate.js";
import * as svc from "./locations.service.js";
import * as s from "./locations.schema.js";
import type { z } from "zod";

// Public and unauthenticated, so the substring search gets a per-IP budget of its own.
const searchLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 60 });

export const locationsRoutes = Router();
// Reference data changes only on re-seed, so clients and CDNs may cache it for a day.
locationsRoutes.use(cacheReference(86_400));

locationsRoutes.get("/divisions", async (_req, res) => ok(res, await svc.listDivisions()));

locationsRoutes.get("/districts", validate({ query: s.districtsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.districtsQuery>>(req);
  ok(res, await svc.listDistricts(query.divisionId));
});
locationsRoutes.get("/upazilas", validate({ query: s.upazilasQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.upazilasQuery>>(req);
  ok(res, await svc.listUpazilas(query.districtId));
});
locationsRoutes.get("/unions", validate({ query: s.unionsQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.unionsQuery>>(req);
  ok(res, await svc.listUnions(query.upazilaId));
});

locationsRoutes.get("/search", searchLimiter, validate({ query: s.searchQuery }), async (req, res) => {
  const { query } = valid<unknown, unknown, z.infer<typeof s.searchQuery>>(req);
  ok(res, await svc.searchLocations(query.q, query.level ? [query.level] : ["district", "upazila", "union"], query.limit));
});
