import { AppError } from "../src/lib/errors.js";
import type { ImageKind, StorageProvider, StoredImage } from "../src/lib/storage/types.js";

/** In-memory StorageProvider: records what would be on Cloudinary so tests can assert on it. */
class FakeStorage implements StorageProvider {
  /** publicId → bytes currently "stored". */
  files = new Map<string, { kind: ImageKind; size: number; createdAt: Date }>();
  /** publicId → the exact bytes that were uploaded (after metadata stripping). */
  bytes = new Map<string, Buffer>();
  /** path → text stored with putText (encrypted documents). */
  texts = new Map<string, string>();
  deleted: string[] = [];
  failUploads = false;
  failDeletes = false;
  /** Make these ids fail to delete (others succeed). */
  failDeleteIds = new Set<string>();
  notConfigured = false;
  listCalls: Array<{ prefix: string; limit: number }> = [];

  reset() {
    this.files.clear();
    this.bytes.clear();
    this.texts.clear();
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

  urlFor(publicId: string, transform?: string) {
    return `https://fake.cdn/${transform ? `${transform}/` : ""}${publicId}`;
  }

  async uploadImage(buffer: Buffer, opts: { kind: ImageKind; publicId: string }): Promise<StoredImage> {
    if (this.failUploads) throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Image upload failed");
    this.files.set(opts.publicId, { kind: opts.kind, size: buffer.length, createdAt: new Date() });
    this.bytes.set(opts.publicId, buffer);
    return { url: this.urlFor(opts.publicId), publicId: opts.publicId, mediaId: `m-${opts.publicId.slice(-6)}`, mime: "image/jpeg", width: 100, height: 100, bytes: buffer.length };
  }

  async putText(text: string, opts: { folder: string; name: string }) {
    if (this.failUploads) throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Upload failed");
    const path = `playerhaat/${opts.folder}/${opts.name}-${this.texts.size + 1}.txt`;
    this.texts.set(path, text);
    this.files.set(path, { kind: "verification-doc", size: text.length, createdAt: new Date() });
    return { path, mediaId: `m${this.texts.size}` };
  }

  async getText(path: string) {
    const t = this.texts.get(path);
    if (t === undefined) throw new AppError("STORAGE_UPLOAD_FAILED", 502, "Couldn't read the document");
    return t;
  }

  async usage() {
    return { provider: "fake", usedBytes: [...this.files.values()].reduce((n, f) => n + f.size, 0), quotaBytes: 1_000_000, files: this.files.size };
  }

  async deleteImage(publicId: string) {
    if (this.failDeletes || this.failDeleteIds.has(publicId)) throw new Error("cloudinary down");
    this.files.delete(publicId);
    this.texts.delete(publicId);
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
