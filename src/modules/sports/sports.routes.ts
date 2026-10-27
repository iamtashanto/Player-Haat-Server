import { Router } from "express";
import { ok } from "../../lib/http.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";
import { cacheReference } from "../../middlewares/cache.js";
import { listSports } from "./sports.service.js";

const Named = z.object({ nameBn: z.string(), nameEn: z.string() });
registerRoute({
  method: "get",
  path: "/sports",
  tag: "Reference",
  summary: "Active sports with their positions",
  response: z.array(Named.extend({ id: z.number(), code: z.string(), positions: z.array(Named.extend({ code: z.string() })) })),
});

export const sportsRoutes = Router();
sportsRoutes.get("/", cacheReference(3600), async (_req, res) => ok(res, await listSports()));
