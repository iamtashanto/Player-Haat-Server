import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Opaque, URL-safe random token (refresh tokens). 48 bytes = 384 bits of entropy. */
export const randomToken = () => randomBytes(48).toString("base64url");

/** Zero-padded numeric code, e.g. "004213". */
export const randomNumericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, "0");

/**
 * Short numeric codes have tiny entropy, so a plain hash would be brute-forced instantly
 * if the table leaked. HMAC with a server secret makes the stored hash useless without it.
 */
export const hashCode = (scope: string, code: string) =>
  createHmac("sha256", env.JWT_ACCESS_SECRET).update(`${scope}:${code}`).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
