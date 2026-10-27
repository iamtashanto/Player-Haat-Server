import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { registerRoute } from "../../lib/openapi.js";
import { z as zz } from "../../lib/zod.js";
import { cacheReference } from "../../middlewares/cache.js";
import { validate } from "../../middlewares/validate.js";
import { compareVersions, getPublicConfig } from "./app-config.service.js";

const query = zz.object({
  appVersion: zz.string().regex(/^\d+(\.\d+){0,2}$/).optional().openapi({ description: "The caller's app version; adds `updateRequired`." }),
});

registerRoute({
  method: "get",
  path: "/app-config",
  tag: "System",
  summary: "Feature flags and minimum app version",
  description: "Public, cached for 5 minutes. Send `?appVersion=1.2.3` to get `updateRequired` (true when below `minAppVersion`).",
  query,
  response: zz.object({
    flags: zz.object({ ads_enabled: zz.boolean(), boost_enabled: zz.boolean() }),
    minAppVersion: zz.string(),
    updateRequired: zz.boolean().optional(),
  }),
  errors: [422],
});

export const appConfigRoutes = Router();
appConfigRoutes.get("/", cacheReference(300), validate({ query }), async (req, res) => {
  const { query: q } = valid<unknown, unknown, z.infer<typeof query>>(req);
  const config = await getPublicConfig();
  ok(res, { ...config, ...(q.appVersion && { updateRequired: compareVersions(q.appVersion, config.minAppVersion) < 0 }) });
});
