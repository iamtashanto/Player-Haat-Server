/** What an image is for — decides folder, size and crop. */
export type ImageKind = "avatar" | "player-photo" | "team-logo";

export interface StoredImage {
  /** Delivery URL (https, auto format/quality). Always derived server-side, never taken from a client. */
  url: string;
  /** Provider id; needed to delete the asset later. */
  publicId: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/**
 * Seam for image storage. Cloudinary today; a Cloudflare R2 implementation only has to
 * satisfy this interface — no module outside lib/storage knows which provider is in use.
 */
export interface StorageProvider {
  /** `publicId` is chosen by the caller (see paths.ts) so ownership can be checked from the id alone. */
  uploadImage(buffer: Buffer, opts: { kind: ImageKind; publicId: string }): Promise<StoredImage>;
  deleteImage(publicId: string): Promise<void>;
  urlFor(publicId: string): string;
  /** Assets under `prefix` created before `olderThan` (at most `limit`) — for the orphan sweeper. */
  listImages(opts: { prefix: string; olderThan: Date; limit: number }): Promise<Array<{ publicId: string; createdAt: Date }>>;
}
