import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/** RFC 6238 TOTP (the algorithm authenticator apps use), on Node's crypto — no extra dependency. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20)); // 160 bits, the size RFC 4226 recommends

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a code against the current step ± 1 (clock drift). Returns the step it matched, or null. Pass the last step
 * already accepted as `after`: a step at or before it is refused, so a code that was just used can't be used again.
 */
export function verifyCode(secret: string, code: string, opts: { after?: number | null; now?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(opts.now);
  for (const step of [now - 1, now, now + 1]) {
    if (opts.after != null && step <= opts.after) continue;
    if (same(codeAt(secret, step), code)) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer = "PlayerHaat") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ── secrets at rest: AES-256-GCM, so a database leak alone doesn't hand out everyone's second factor ──
const key = () => createHash("sha256").update(`playerhaat-totp:${env.ADMIN_TOTP_KEY ?? env.JWT_ACCESS_SECRET}`).digest();

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
}

// ── backup codes: shown once, kept only as hashes ──
export const newBackupCodes = (n = 8) => Array.from({ length: n }, () => `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`);
export const hashBackupCode = (code: string) => createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
