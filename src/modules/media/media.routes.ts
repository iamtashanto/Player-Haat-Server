import { Router } from "express";
import type { z } from "zod";
import { created, ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { imageUpload } from "../../middlewares/upload.js";
import { validate } from "../../middlewares/validate.js";
import * as svc from "./media.service.js";
import * as s from "./media.schema.js";

export const uploadLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 });

export const mediaRoutes = Router();
mediaRoutes.use(requireAuth);

mediaRoutes.post("/images", uploadLimiter, imageUpload("file"), validate({ body: s.uploadBody }), async (req, res) => {
  const { body } = valid<z.infer<typeof s.uploadBody>>(req);
  created(res, await svc.uploadOwnedImage(authUser(req).userId, body.type, req.image!.buffer));
});

mediaRoutes.delete("/images", validate({ body: s.deleteImageBody }), async (req, res) => {
  const { body } = valid<z.infer<typeof s.deleteImageBody>>(req);
  await svc.deleteOwnedImage(authUser(req).userId, body.publicId);
  ok(res, { success: true });
});
