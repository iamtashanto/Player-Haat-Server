import { logger } from "../logger.js";
import { storage } from "./index.js";

/**
 * Best-effort cleanup after the DB has already changed. A failed provider call must not undo a
 * user-visible change, so it is logged for a later sweep instead of thrown.
 */
export async function deleteImagesQuietly(publicIds: Array<string | null | undefined>): Promise<void> {
  const ids = publicIds.filter((id): id is string => !!id);
  const results = await Promise.allSettled(ids.map((id) => storage.deleteImage(id)));
  results.forEach((r, i) => {
    if (r.status === "rejected") logger.warn({ publicId: ids[i], err: r.reason }, "failed to delete stored image");
  });
}
