import { AppError } from "../src/lib/errors.js";
import type { ImageKind, StorageProvider, StoredImage } from "../src/lib/storage/types.js";

/** In-memory StorageProvider: records what would be on Cloudinary so tests can assert on it. */
class FakeStorage implements StorageProvider {
  /** publicId → bytes currently "stored". */
  files = new Map<string, { kind: ImageKind; size: number; createdAt: Date }>();
  deleted: string[] = [];
  failUploads = false;
  failDeletes = false;
  /** Make these ids fail to delete (others succeed). */
  failDeleteIds = new Set<string>();
  notConfigured = false;
  listCalls: Array<{ prefix: string; limit: number }> = [];

  reset() {
    this.files.clear();
    this.deleted = [];
    this.failUploads = false;
    this.failDeletes = false;
    this.failDeleteIds.clear();
    this.notConfigured = false;
    this.listCalls = [];
  }

  /** Test helper: pretend an asset was uploaded `hoursAgo` hours ago. */
  put(publicId: string, hoursAgo = 0, kind: ImageKind = "player-photo") {
    this.files.set(publicId, { kind, size: 1, createdAt: new Date(Date.now() - hoursAgo * 3_600_000) });
  }

  urlFor(publicId: string) {
    return `https://fake.cdn/${publicId}`;
  }

  async uploadImage(buffer: Buffer, opts: { kind: ImageKind; publicId: string }): Promise<StoredImage> {
    if (this.failUploads) throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed");
    this.files.set(opts.publicId, { kind: opts.kind, size: buffer.length, createdAt: new Date() });
    return { url: this.urlFor(opts.publicId), publicId: opts.publicId, width: 100, height: 100, bytes: buffer.length };
  }

  async deleteImage(publicId: string) {
    if (this.failDeletes || this.failDeleteIds.has(publicId)) throw new Error("cloudinary down");
    this.files.delete(publicId);
    this.deleted.push(publicId);
  }

  async listImages(opts: { prefix: string; olderThan: Date; limit: number }) {
    if (this.notConfigured) throw new AppError("STORAGE_NOT_CONFIGURED", 503, "Image storage is not configured");
    this.listCalls.push({ prefix: opts.prefix, limit: opts.limit });
    return [...this.files.entries()]
      .filter(([id, f]) => id.startsWith(opts.prefix) && f.createdAt < opts.olderThan)
      .map(([publicId, f]) => ({ publicId, createdAt: f.createdAt }))
      .slice(0, opts.limit);
  }
}


export const fakeStorage = new FakeStorage();
