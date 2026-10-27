import type { Request, RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { sniffImageType, type ImageMime } from "../lib/image-sniff.js";
import { AppError } from "../lib/errors.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

declare global {
  namespace Express {
    interface Request {
      /** Set by `imageUpload`: the validated, in-memory image. */
      image?: { buffer: Buffer; mimeType: ImageMime; size: number };
    }
  }
}

const parser = multer({
  storage: multer.memoryStorage(), // nothing touches disk; the 5 MB cap bounds memory per request
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new AppError("MEDIA_UNSUPPORTED_TYPE", 415, "Only jpeg, png, webp and heic images are allowed")),
});

/**
 * multipart/form-data with a single image in `field`. Rejects (in order): wrong declared type,
 * files over 5 MB, missing file, and files whose actual bytes aren't an allowed image format.
 */
export const imageUpload = (field = "file"): RequestHandler => {
  const single = parser.single(field);
  return (req: Request, res, next) => {
    single(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(new AppError("MEDIA_TOO_LARGE", 413, `Image must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`));
        }
        return next(new AppError("MEDIA_INVALID_UPLOAD", 422, err.message));
      }
      if (err) return next(err);

      if (!req.file) return next(new AppError("MEDIA_FILE_REQUIRED", 422, `Send an image in the "${field}" field`));
      const mimeType = sniffImageType(req.file.buffer);
      if (!mimeType) {
        return next(new AppError("MEDIA_UNSUPPORTED_TYPE", 415, "File content is not a supported image"));
      }
      req.image = { buffer: req.file.buffer, mimeType, size: req.file.size };
      next();
    });
  };
};
