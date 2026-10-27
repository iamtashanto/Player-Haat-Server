import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/lib/crypto.js";

// The global mock replaces the module for HTTP tests; here we exercise the real implementation.
const { verifyAppleIdentityToken } = await vi.importActual<typeof import("../src/lib/social/apple.js")>(
  "../src/lib/social/apple.js",
);

const AUD = "com.playerhaat.test";
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

interface Claims {
  iss?: string;
  aud?: string;
  exp?: number | string;
  extra?: Record<string, unknown>;
  key?: CryptoKey;
}
const token = ({ iss = "https://appleid.apple.com", aud = AUD, exp = "10m", extra = {}, key }: Claims = {}) =>
  new SignJWT({ email: "u@example.com", email_verified: "true", ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("apple-sub-1")
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key ?? privateKey);

describe("verifyAppleIdentityToken (real implementation, local JWKS)", () => {
  it("accepts a valid token and reads sub/email, treating email_verified:'true' as verified", async () => {
    const p = await verifyAppleIdentityToken(await token(), { keys });
    expect(p).toEqual({ provider: "APPLE", providerUserId: "apple-sub-1", email: "u@example.com", emailVerified: true });
  });

  it("handles a boolean email_verified and an unverified one", async () => {
    expect((await verifyAppleIdentityToken(await token({ extra: { email_verified: true } }), { keys })).emailVerified).toBe(true);
    expect((await verifyAppleIdentityToken(await token({ extra: { email_verified: "false" } }), { keys })).emailVerified).toBe(false);
  });

  it("rejects a wrong audience", async () => {
    await expect(verifyAppleIdentityToken(await token({ aud: "com.someone.else" }), { keys })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
      status: 401,
    });
  });

  it("rejects a wrong issuer", async () => {
    await expect(verifyAppleIdentityToken(await token({ iss: "https://evil.example.com" }), { keys })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
    });
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    await expect(verifyAppleIdentityToken(await token({ exp: past }), { keys })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
    });
  });

  it("rejects a token signed by a key that isn't in Apple's JWKS", async () => {
    await expect(verifyAppleIdentityToken(await token({ key: otherPrivateKey }), { keys })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
    });
  });

  it("rejects an unsigned (alg:none) token", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ iss: "https://appleid.apple.com", aud: AUD, sub: "x", exp: 9999999999 }),
    ).toString("base64url")}.`;
    await expect(verifyAppleIdentityToken(none, { keys })).rejects.toMatchObject({ code: "AUTH_INVALID_SOCIAL_TOKEN" });
  });

  it("checks the nonce: raw or SHA-256 accepted, mismatch rejected, absent token nonce rejected", async () => {
    const raw = "my-raw-nonce";
    await expect(verifyAppleIdentityToken(await token({ extra: { nonce: raw } }), { keys, nonce: raw })).resolves.toBeTruthy();
    await expect(
      verifyAppleIdentityToken(await token({ extra: { nonce: sha256(raw) } }), { keys, nonce: raw }),
    ).resolves.toBeTruthy();
    await expect(verifyAppleIdentityToken(await token({ extra: { nonce: "other" } }), { keys, nonce: raw })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
    });
    await expect(verifyAppleIdentityToken(await token(), { keys, nonce: raw })).rejects.toMatchObject({
      code: "AUTH_INVALID_SOCIAL_TOKEN",
    });
  });
});
