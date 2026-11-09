import { env } from "../../config/env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { sniffImageType } from "../image-sniff.js";
import type { ImageKind, StorageProvider, StoredImage } from "./types.js";

/** The media service project prefix: it prepends this to every folder, so it is never sent. */
const PROJECT = "playerhaat/";
const TIMEOUT_MS = 20_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

interface MediaFile {
  id: string;
  path: string;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
  created_at?: string;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };

/**
 * Our own media service (https://media.tashanto.com). The API key never leaves this process: clients upload to our
 * API, we check auth/type/size/ownership, then forward the bytes here.
 *
 * Ids line up with `paths.ts`: `publicId` = the service `path` = `playerhaat/<env>/<kind folder>/<userId>/<name>`, so
 * `isOwnedBy` keeps working. The service appends a random suffix to the file name, so callers must keep the `publicId`
 * we return (never the one they asked for).
 */
export class TashantoMediaStorage implements StorageProvider {
  private cfg() {
    if (!env.MEDIA_BASE_URL || !env.MEDIA_API_KEY) throw new AppError("STORAGE_NOT_CONFIGURED", 503, "Image storage is not configured");
    return { base: env.MEDIA_BASE_URL.replace(/\/+$/, ""), key: env.MEDIA_API_KEY };
  }

  /** One request with a timeout and a single retry on 429/5xx. Never logs the key or the file body. */
  private async call(path: string, init: RequestInit): Promise<Response> {
    const { base, key } = this.cfg();
    let last: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${base}/api/v1${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!RETRY_STATUSES.has(res.status) || attempt === 1) return res;
        last = res;
        const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || 400, 2000);
        await new Promise((r) => setTimeout(r, wait));
      } catch (err) {
        if (attempt === 1) throw err;
      }
    }
    return last!;
  }

  urlFor(publicId: string): string {
    return `${this.cfg().base}/img/-/${publicId}`;
  }

  async uploadImage(buffer: Buffer, opts: { kind: ImageKind; publicId: string }): Promise<StoredImage> {
    const mime = sniffImageType(buffer);
    if (!mime) throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed");
    const idx = opts.publicId.lastIndexOf("/");
    const dir = opts.publicId.slice(0, idx);
    const folder = dir.startsWith(PROJECT) ? dir.slice(PROJECT.length) : dir;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(buffer)], { type: mime }), `${opts.publicId.slice(idx + 1)}.${EXT[mime]}`);
    form.set("folder", folder);
    let res: Response;
    try {
      res = await this.call("/upload", { method: "POST", body: form });
    } catch (err) {
      logger.error({ err: String(err) }, "media upload failed (network)");
      throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed");
    }
    if (res.status !== 201) {
      logger.error({ status: res.status }, "media upload rejected");
      throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed");
    }
    const f = (await res.json()) as MediaFile;
    return { url: this.urlFor(f.path), publicId: f.path, width: f.width, height: f.height, bytes: f.size };
  }

  /** The service deletes by its own id, so look the file up by folder first. A missing file is not an error. */
  async deleteImage(publicId: string): Promise<void> {
    const found = await this.find(publicId);
    if (!found) return;
    const res = await this.call(`/files/${encodeURIComponent(found.id)}`, { method: "DELETE" });
    if (res.status !== 200 && res.status !== 404) {
      logger.error({ status: res.status }, "media delete failed");
      throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image delete failed");
    }
  }

  private async find(path: string): Promise<MediaFile | null> {
    const idx = path.lastIndexOf("/");
    const dir = path.slice(0, idx);
    const folder = dir.startsWith(PROJECT) ? dir.slice(PROJECT.length) : dir;
    const res = await this.call(`/files?folder=${encodeURIComponent(folder)}&limit=100`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { files?: MediaFile[] };
    return body.files?.find((f) => f.path === path) ?? null;
  }

  async listImages(opts: { prefix: string; olderThan: Date; limit: number }) {
    const folder = opts.prefix.startsWith(PROJECT) ? opts.prefix.slice(PROJECT.length) : opts.prefix;
    const out: Array<{ publicId: string; createdAt: Date }> = [];
    for (let offset = 0; offset < 5000 && out.length < opts.limit; offset += 100) {
      const res = await this.call(`/files?folder=${encodeURIComponent(folder.replace(/\/+$/, ""))}&recursive=1&limit=100&offset=${offset}`, { method: "GET" });
      if (res.status !== 200) break;
      const files = ((await res.json()) as { files?: MediaFile[] }).files ?? [];
      for (const f of files) {
        const createdAt = new Date(`${(f.created_at ?? "").replace(" ", "T")}Z`); // the service reports UTC without a zone
        if (!Number.isNaN(createdAt.getTime()) && createdAt < opts.olderThan) out.push({ publicId: f.path, createdAt });
      }
      if (files.length < 100) break;
    }
    return out.slice(0, opts.limit);
  }
}
