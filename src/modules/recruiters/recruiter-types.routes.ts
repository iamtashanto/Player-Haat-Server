import { Router } from "express";
import { ok } from "../../lib/http.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";
import { cacheReference } from "../../middlewares/cache.js";
import { listRecruiterTypes } from "./recruiter-types.js";

registerRoute({
  method: "get",
  path: "/recruiter-types",
  tag: "Reference",
  summary: "Recruiter types a recruiter can choose from, with display names",
  response: z.array(z.object({ code: z.string(), nameEn: z.string(), nameBn: z.string() })),
});

/** Public reference data, like /sports: a signing-up recruiter needs it before they have a profile. */
export const recruiterTypesRoutes = Router();
recruiterTypesRoutes.get("/", cacheReference(3600), (_req, res) => ok(res, listRecruiterTypes()));
