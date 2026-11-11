import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

/**
 * Verification documents are encrypted before they leave our process. The media service has no private mode (every
 * file is reachable at /f/<path>), so what it stores must be unreadable without our key. Format (ASCII, so the
 * service accepts it as a text file): `ph1.<iv>.<tag>.<ciphertext>`, each part base64. The owner's id is bound in as
 * additional data, so a blob copied into another user's folder will not decrypt for them.
 */
function key(): Buffer {
  const raw = env.EVIDENCE_ENCRYPTION_KEY?.trim();
  if (!raw) throw new AppError("EVIDENCE_NOT_CONFIGURED", 503, "Document uploads aren't set up on this server");
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new AppError("EVIDENCE_NOT_CONFIGURED", 503, "Document uploads aren't set up on this server");
  return k;
}

export const evidenceConfigured = () => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

export function encryptEvidence(plain: Buffer, ownerId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(ownerId));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["ph1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptEvidence(text: string, ownerId: string): Buffer {
  const [v, iv, tag, ct] = text.trim().split(".");
  if (v !== "ph1" || !iv || !tag || !ct) throw new AppError("EVIDENCE_CORRUPT", 500, "Document can't be read");
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(ownerId));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("EVIDENCE_CORRUPT", 500, "Document can't be read");
  }
}
