import { Router } from "express";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter } from "../../middlewares/rate-limit.js";
import { imageUpload } from "../../middlewares/upload.js";
import { validate } from "../../middlewares/validate.js";
import * as account from "../auth/account.service.js";
import { deleteAccountBody } from "../auth/auth.schema.js";
import { uploadLimiter } from "../media/media.routes.js";
import * as svc from "./users.service.js";
import * as s from "./users.schema.js";

const sensitive = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });

export const usersRoutes = Router();
usersRoutes.use(requireAuth);

usersRoutes.get("/me", async (req, res) => ok(res, await svc.getMe(authUser(req).userId)));

usersRoutes.patch("/me", validate({ body: s.updateMeBody }), async (req, res) => {
  const { body } = valid<z.infer<typeof s.updateMeBody>>(req);
  ok(res, await svc.updateMe(authUser(req).userId, body));
});

usersRoutes.put("/me/avatar", uploadLimiter, imageUpload("file"), async (req, res) => {
  ok(res, await svc.setAvatar(authUser(req).userId, req.image!.buffer));
});
usersRoutes.delete("/me/avatar", async (req, res) => ok(res, await svc.removeAvatar(authUser(req).userId)));

// Same behaviour as DELETE /auth/account (Play Store / App Store account-deletion requirement).
usersRoutes.delete("/me", sensitive, validate({ body: deleteAccountBody }), async (req, res) => {
  const { body } = valid<z.infer<typeof deleteAccountBody>>(req);
  await account.deleteAccount(authUser(req).userId, body);
  ok(res, { success: true });
});
