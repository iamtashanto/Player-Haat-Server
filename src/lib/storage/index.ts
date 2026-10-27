import { CloudinaryStorage } from "./cloudinary.js";
import type { StorageProvider } from "./types.js";

/** The one place that picks the provider. Swap this line to move to Cloudflare R2. */
export const storage: StorageProvider = new CloudinaryStorage();
export type { ImageKind, StorageProvider, StoredImage } from "./types.js";
