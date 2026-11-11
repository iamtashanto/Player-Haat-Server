import { Router } from "express";
import type { Response } from "express";
import type { z } from "zod";
import { created, valid } from "../../lib/http.js";
import { authUser, requireAuth } from "../../middlewares/auth.js";
import { imageUpload } from "../../middlewares/upload.js";
import { validate } from "../../middlewares/validate.js";
import { uploadLimiter } from "../media/media.routes.js";
import * as svc from "./verification.service.js";
import * as s from "./verification.schema.js";

/** Sends a decrypted document: never cached, never sniffed, never framed. */
export function sendDocument(res: Response, doc: { bytes: Buffer; mime: string }) {
  res
    .status(200)
    .set({ "Content-Type": doc.mime, "Content-Length": String(doc.bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'" })
    .end(doc.bytes);
}

/** Mounted at /verification behind the app-user guard. */
export const verificationRoutes = Router();
verificationRoutes.use(requireAuth);

verificationRoutes.post("/files", uploadLimiter, imageUpload("file"), async (req, res) => {
  created(res, await svc.uploadFile(authUser(req).userId, req.image!.buffer));
});
verificationRoutes.get("/files/:fileId", validate({ params: s.fileParams }), async (req, res) => {
  sendDocument(res, await svc.ownFile(authUser(req).userId, valid<unknown, z.infer<typeof s.fileParams>>(req).params.fileId));
});
