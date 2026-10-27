import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env.js";
import { AppError, ErrorCode } from "../errors.js";
import type { SocialProfile } from "./types.js";

const client = new OAuth2Client();

/** Verifies signature, expiry and audience (our Android/iOS/web client IDs) of a Google ID token. */
export async function verifyGoogleIdToken(idToken: string): Promise<SocialProfile> {
  if (env.GOOGLE_CLIENT_IDS.length === 0) {
    throw new AppError(ErrorCode.AUTH_PROVIDER_NOT_CONFIGURED, 503, "Google sign-in is not configured");
  }
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_IDS });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error("no sub");
    return {
      provider: "GOOGLE",
      providerUserId: p.sub,
      email: p.email?.toLowerCase(),
      emailVerified: p.email_verified === true,
      name: p.name,
      picture: p.picture,
    };
  } catch {
    throw AppError.unauthorized(ErrorCode.AUTH_INVALID_SOCIAL_TOKEN, "Invalid Google token");
  }
}
