import { v2 as cloudinary, type UploadApiOptions } from "cloudinary";
import { env } from "../../config/env.js";
import { AppError } from "../errors.js";
import type { ImageKind, StorageProvider, StoredImage } from "./types.js";

// Incoming transformations: bound the stored size, and crop avatars around the face.
const TRANSFORM: Record<ImageKind, UploadApiOptions["transformation"]> = {
  avatar: [{ width: 512, height: 512, crop: "fill", gravity: "face" }],
  "player-photo": [{ width: 1600, height: 1600, crop: "limit" }],
  "team-logo": [{ width: 512, height: 512, crop: "limit" }],
  "verification-doc": [{ width: 2000, height: 2000, crop: "limit" }], // legible documents, bounded size
};

export class CloudinaryStorage implements StorageProvider {
  private configured = false;

  private ensureConfigured() {
    if (this.configured) return;
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      throw new AppError("STORAGE_NOT_CONFIGURED", 503, "Image storage is not configured");
    }
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    this.configured = true;
  }

  urlFor(publicId: string): string {
    this.ensureConfigured();
    // f_auto/q_auto: Cloudinary serves WebP/AVIF/JPEG at the right quality per device.
    return cloudinary.url(publicId, { secure: true, fetch_format: "auto", quality: "auto" });
  }

  uploadImage(buffer: Buffer, opts: { kind: ImageKind; publicId: string }): Promise<StoredImage> {
    this.ensureConfigured();
    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            public_id: opts.publicId,
            resource_type: "image",
            overwrite: false,
            transformation: TRANSFORM[opts.kind],
          },
          (err, res) => {
            if (err || !res) return reject(new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed"));
            resolve({
              url: this.urlFor(res.public_id),
              publicId: res.public_id,
              width: res.width,
              height: res.height,
              bytes: res.bytes,
            });
          },
        )
        .end(buffer);
    });
  }

  async listImages(opts: { prefix: string; olderThan: Date; limit: number }) {
    this.ensureConfigured();
    const found: Array<{ publicId: string; createdAt: Date }> = [];
    let cursor: string | undefined;
    // The Admin API is rate-limited, so cap pages as well as results.
    for (let page = 0; page < 20 && found.length < opts.limit; page++) {
      const res = await cloudinary.api.resources({ type: "upload", prefix: opts.prefix, max_results: 500, next_cursor: cursor });
      for (const r of res.resources as Array<{ public_id: string; created_at: string }>) {
        const createdAt = new Date(r.created_at);
        if (createdAt < opts.olderThan) found.push({ publicId: r.public_id, createdAt });
      }
      cursor = res.next_cursor;
      if (!cursor) break;
    }
    return found.slice(0, opts.limit);
  }

  async deleteImage(publicId: string): Promise<void> {
    this.ensureConfigured();
    // result is "ok" or "not found"; both mean the asset is gone.
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  }
}
