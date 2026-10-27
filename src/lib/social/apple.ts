import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../../config/env.js";
import { sha256 } from "../crypto.js";
import { AppError, ErrorCode } from "../errors.js";
import type { SocialProfile } from "./types.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

interface VerifyOptions {
  /** Raw nonce the app generated. Apple embeds it either raw or SHA-256 hex, depending on the client library. */
  nonce?: string;
  /** Injectable key set — tests pass a local JWKS instead of hitting Apple. */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifies Apple's identity token: RS256 signature against Apple's JWKS, `iss`, `aud`
 * (our iOS bundle id / Services ID) and `exp`. Apple only sends the user's name on the very
 * first authorization, and never inside this token — the caller passes it separately.
 */
export async function verifyAppleIdentityToken(identityToken: string, opts: VerifyOptions = {}): Promise<SocialProfile> {
  if (env.APPLE_CLIENT_IDS.length === 0) {
    throw new AppError(ErrorCode.AUTH_PROVIDER_NOT_CONFIGURED, 503, "Apple sign-in is not configured");
  }
  try {
    const { payload } = await jwtVerify(identityToken, opts.keys ?? appleKeys, {
      issuer: APPLE_ISSUER,
      audience: env.APPLE_CLIENT_IDS,
      algorithms: ["RS256"],
    });
    if (!payload.sub) throw new Error("no sub");

    if (opts.nonce !== undefined) {
      const tokenNonce = payload.nonce;
      if (tokenNonce !== opts.nonce && tokenNonce !== sha256(opts.nonce)) throw new Error("nonce mismatch");
    }

    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
    // Apple sends email_verified as either a boolean or the string "true".
    const verified = payload.email_verified === true || payload.email_verified === "true";
    return { provider: "APPLE", providerUserId: payload.sub, email, emailVerified: !!email && verified };
  } catch {
    throw AppError.unauthorized(ErrorCode.AUTH_INVALID_SOCIAL_TOKEN, "Invalid Apple token");
  }
}
