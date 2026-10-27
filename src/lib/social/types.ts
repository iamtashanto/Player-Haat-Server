export type SocialProvider = "GOOGLE" | "APPLE";

/** What we take from a verified provider token — nothing else is trusted from the client. */
export interface SocialProfile {
  provider: SocialProvider;
  providerUserId: string;
  email?: string; // lower-cased
  emailVerified: boolean;
  name?: string;
  picture?: string;
}
