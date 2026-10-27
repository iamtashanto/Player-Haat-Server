import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const binary = z.string().openapi({ type: "string", format: "binary" });

export const uploadBody = z.object({ type: z.enum(["avatar", "player-photo", "team-logo", "verification-doc"]) });
export const deleteImageBody = z.object({ publicId: z.string().min(10).max(300) });

export const UploadedImageSchema = z.object({
  url: z.string().url(),
  publicId: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  bytes: z.number().optional(),
});

registerRoute({
  method: "post",
  path: "/media/images",
  tag: "Media",
  summary: "Upload an image",
  description:
    "multipart/form-data, field `file` (jpeg/png/webp/heic, max 5 MB) + `type`. Stored under your own folder; " +
    "`url` is the delivery URL (auto format/quality). Prefer the one-step endpoints (avatar, player photos) — " +
    "this one is for assets you will attach yourself, e.g. team logos. Uploads that aren't attached to anything are deleted after 24 hours.",
  auth: true,
  multipart: uploadBody.extend({ file: binary }),
  response: UploadedImageSchema,
  status: 201,
  errors: [413, 415, 422, 502, 503],
});
registerRoute({
  method: "delete",
  path: "/media/images",
  tag: "Media",
  summary: "Delete one of my unattached uploads",
  description: "Fails with 409 if the image is still used as an avatar or profile photo.",
  auth: true,
  body: deleteImageBody,
  errors: [403, 409, 422],
});
