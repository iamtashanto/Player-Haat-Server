import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { ImageKind } from "./types.js";

// One folder per kind, namespaced by environment so dev uploads never mix with production.
const ROOT = `playerhaat/${env.NODE_ENV}`;
/** Everything this environment ever uploads lives under here (and nothing else does). */
export const STORAGE_PREFIX = `${ROOT}/`;
const FOLDER: Record<ImageKind, string> = {
  avatar: "avatars",
  "player-photo": "player-photos",
  "team-logo": "team-logos",
  "verification-doc": "verification-docs",
};

/** `<root>/<folder>/<userId>/` — every image a user uploads lives under their own prefix. */
export const ownerPrefix = (kind: ImageKind, userId: string) => `${ROOT}/${FOLDER[kind]}/${userId}/`;

export const newPublicId = (kind: ImageKind, userId: string) => `${ownerPrefix(kind, userId)}${randomUUID()}`;

/**
 * Ownership is encoded in the id, so we can verify "this publicId belongs to this user"
 * without a lookup table — and without ever trusting a client-supplied URL.
 */
export const isOwnedBy = (userId: string, publicId: string) =>
  (Object.keys(FOLDER) as ImageKind[]).some((k) => publicId.startsWith(ownerPrefix(k, userId)));
