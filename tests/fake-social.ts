import { AppError, ErrorCode } from "../src/lib/errors.js";
import type { SocialProfile, SocialProvider } from "../src/lib/social/types.js";

/**
 * Stand-ins for Google/Apple verification at the HTTP level. A "token" is just an encoded profile;
 * anything else is rejected like a bad signature would be. (The real Apple verifier has its own
 * tests with generated keys in apple.test.ts; Google's is a thin wrapper over google-auth-library.)
 */
const PREFIX = "fake-token.";

export function fakeToken(p: Partial<Omit<SocialProfile, "provider">> & { providerUserId: string }): string {
  return PREFIX + Buffer.from(JSON.stringify({ emailVerified: true, ...p })).toString("base64url");
}

export const fakeVerify = (provider: SocialProvider) => async (token: string): Promise<SocialProfile> => {
  if (!token.startsWith(PREFIX)) throw AppError.unauthorized(ErrorCode.AUTH_INVALID_SOCIAL_TOKEN);
  const data = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString());
  return { provider, ...data, email: data.email?.toLowerCase() };
};
