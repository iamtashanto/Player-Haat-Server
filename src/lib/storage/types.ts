/** What an image is for — decides folder, size and crop. */
export type ImageKind = "avatar" | "player-photo" | "player-cover" | "team-logo" | "recruiter-logo" | "verification-doc";

export interface StoredImage {
  /** The provider's own id for the file (media service), when it has one. */
  mediaId?: string;
  mime?: string;
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
  /** `transform` is a media-service transform such as `w_400` or `w_1200,h_630,c_fill`; omitted = the original size. */
  urlFor(publicId: string, transform?: string): string;
  /** Stores opaque text (an encrypted document) in `folder` and returns where. Never produces a public URL for callers. */
  putText?(text: string, opts: { folder: string; name: string }): Promise<{ path: string; mediaId?: string }>;
  getText?(path: string): Promise<string>;
  /** Storage used and quota, when the provider can tell. */
  usage?(): Promise<{ provider: string; usedBytes: number; quotaBytes: number; files: number }>;
  /** Assets under `prefix` created before `olderThan` (at most `limit`) — for the orphan sweeper. */
  listImages(opts: { prefix: string; olderThan: Date; limit: number }): Promise<Array<{ publicId: string; createdAt: Date }>>;
}
