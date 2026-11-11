import { env } from "../../config/env.js";
import { CloudinaryStorage } from "./cloudinary.js";
import { TashantoMediaStorage } from "./tashanto.js";
import type { StorageProvider } from "./types.js";

/** The one place that picks the provider: our media service when configured (the default), Cloudinary as the fallback. */
const wanted = env.STORAGE_PROVIDER ?? (env.MEDIA_API_KEY ? "tashanto" : "cloudinary");
export const storage: StorageProvider = wanted === "tashanto" ? new TashantoMediaStorage() : new CloudinaryStorage();
export type { ImageKind, StorageProvider, StoredImage } from "./types.js";
