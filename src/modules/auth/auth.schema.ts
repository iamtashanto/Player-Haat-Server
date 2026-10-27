import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";
import { phone } from "../users/users.schema.js";

// ───────── shared field schemas ─────────
const email = z.string().trim().toLowerCase().max(254).email().openapi({ example: "rakib@example.com" });
const password = z
  .string()
  .min(8, "At least 8 characters")
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Must contain a letter and a number")
  .openapi({ example: "Sup3rSecret" });
const code = z.string().regex(/^\d{6}$/, "6-digit code").openapi({ example: "042913" });
const deviceId = z.string().trim().min(1).max(100).optional().openapi({ description: "Stable per-install id; groups sessions per device." });
const refreshToken = z.string().min(20).max(200);

// Admins are never created through sign-up, so ADMIN is deliberately not selectable here.
const signupRole = z
  .enum(["PLAYER", "RECRUITER"])
  .optional()
  .openapi({ description: "Account type, chosen once at sign-up. Defaults to PLAYER. Ignored when signing in to an existing account." });

// ───────── request bodies ─────────
export const registerBody = z.object({
  name: z.string().trim().min(1).max(80),
  email,
  password,
  role: signupRole,
  locale: z.enum(["bn", "en"]).optional(),
  deviceId,
});
export const loginBody = z.object({ email, password: z.string().min(1).max(128), deviceId });
export const verifyEmailBody = z.object({ email, code });
export const forgotPasswordBody = z.object({ email });
export const resetPasswordBody = z.object({ email, code, newPassword: password });
export const setPasswordBody = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: password,
  deviceId,
});
export const googleBody = z.object({ idToken: z.string().min(20).max(5000), role: signupRole, deviceId });
export const appleBody = z.object({
  identityToken: z.string().min(20).max(5000),
  nonce: z.string().max(200).optional().openapi({ description: "Raw nonce, if the app sent one to Apple." }),
  role: signupRole,
  name: z
    .string()
    .trim()
    .max(80)
    .optional()
    .openapi({ description: "Apple sends the name only on first authorization — pass it through on that call." }),
  deviceId,
});
export const linkGoogleBody = z.object({ idToken: googleBody.shape.idToken });
export const linkAppleBody = z.object({ identityToken: appleBody.shape.identityToken, nonce: appleBody.shape.nonce });
export const refreshBody = z.object({ refreshToken, deviceId });
export const logoutBody = z.object({ refreshToken });
export const deleteAccountBody = z.object({
  password: z.string().max(128).optional(),
  confirm: z.literal("DELETE"),
});
export const phoneRequestBody = z.strictObject({ phone });
export const phoneVerifyBody = z.strictObject({
  phone,
  code,
  name: z.string().trim().min(1).max(80).optional().openapi({ description: "Used only when this creates a new account." }),
  role: signupRole,
  deviceId,
});
export const linkPhoneBody = z.strictObject({ phone, code });
export const providerParams = z.object({ provider: z.enum(["EMAIL", "PHONE", "GOOGLE", "APPLE"]) });

// ───────── responses ─────────
const TokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().openapi({ description: "Access token lifetime, seconds" }),
  refreshExpiresAt: z.string().datetime(),
});
const AuthUserSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    phone: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    locale: z.enum(["bn", "en"]),
    role: z.enum(["PLAYER", "RECRUITER", "ADMIN"]),
    hasPassword: z.boolean(),
    loginMethods: z.array(z.enum(["EMAIL", "PHONE", "GOOGLE", "APPLE"])),
  })
  .openapi("AuthUser");
const SessionSchema = z.object({ user: AuthUserSchema, tokens: TokensSchema }).openapi("AuthSession");
const PhoneSessionSchema = SessionSchema.extend({ isNewUser: z.boolean() }).openapi("PhoneAuthSession");

// ───────── OpenAPI ─────────
const T = "Auth";
registerRoute({ method: "post", path: "/auth/register", tag: T, summary: "Register with email + password", description: "Signs the user in immediately and emails a 6-digit verification code.", body: registerBody, response: SessionSchema, status: 201, errors: [409, 422] });
registerRoute({ method: "post", path: "/auth/login", tag: T, summary: "Log in with email + password", description: "Players and recruiters only. Admin accounts get 403 `AUTH_ADMIN_DASHBOARD_ONLY` and must use `/admin/auth/login`.", body: loginBody, response: SessionSchema, errors: [401, 403, 422] });
registerRoute({ method: "post", path: "/auth/phone/request", tag: T, summary: "Text a sign-in code to a Bangladeshi mobile number", description: "6-digit code, valid 5 minutes. 60s between texts, 5 per hour per number. Responds the same whether or not the number has an account.", body: phoneRequestBody, errors: [422, 429, 502, 503] });
registerRoute({ method: "post", path: "/auth/phone/verify", tag: T, summary: "Sign in (or sign up) with the texted code", description: "`isNewUser` tells the app to run the profile wizard. A number someone typed into their profile but never verified is released to whoever proves they hold it.", body: phoneVerifyBody, response: PhoneSessionSchema, errors: [400, 403, 422, 429] });
registerRoute({ method: "post", path: "/auth/google", tag: T, summary: "Sign in with Google", description: "Send the Google `idToken`. Links to an existing account when the verified email matches.", body: googleBody, response: SessionSchema, errors: [401, 403, 503] });
registerRoute({ method: "post", path: "/auth/apple", tag: T, summary: "Sign in with Apple", body: appleBody, response: SessionSchema, errors: [401, 403, 503] });
registerRoute({ method: "post", path: "/auth/refresh", tag: T, summary: "Rotate the refresh token", description: "Single-use: the old token is consumed. Replaying a used token revokes the whole session family.", body: refreshBody, response: TokensSchema, errors: [401, 403] });
registerRoute({ method: "post", path: "/auth/logout", tag: T, summary: "Log out this device", body: logoutBody });
registerRoute({ method: "post", path: "/auth/logout-all", tag: T, summary: "Log out every device", auth: true });
registerRoute({ method: "post", path: "/auth/verify-email", tag: T, summary: "Verify email with the emailed code", body: verifyEmailBody, response: z.object({ verified: z.literal(true), alreadyVerified: z.boolean() }), errors: [400, 422] });
registerRoute({ method: "post", path: "/auth/resend-verification", tag: T, summary: "Resend the verification code", auth: true, errors: [409] });
registerRoute({ method: "post", path: "/auth/forgot-password", tag: T, summary: "Request a password-reset code", description: "Always returns success so it can't reveal which emails are registered.", body: forgotPasswordBody, errors: [422] });
registerRoute({ method: "post", path: "/auth/reset-password", tag: T, summary: "Reset password with the emailed code", description: "Revokes every session.", body: resetPasswordBody, errors: [400, 422, 429] });
registerRoute({ method: "put", path: "/auth/password", tag: T, summary: "Set or change password", description: "Social-only users can add a password; others must send `currentPassword`. Revokes all sessions and returns a new pair.", auth: true, body: setPasswordBody, response: SessionSchema, errors: [400, 409, 422] });
registerRoute({ method: "get", path: "/auth/methods", tag: T, summary: "My login methods", auth: true, response: AuthUserSchema });
registerRoute({ method: "post", path: "/auth/methods/phone", tag: T, summary: "Link a verified phone number", description: "Request a code with /auth/phone/request first.", auth: true, body: linkPhoneBody, response: AuthUserSchema, errors: [400, 409, 422] });
registerRoute({ method: "post", path: "/auth/methods/google", tag: T, summary: "Link Google", auth: true, body: linkGoogleBody, response: AuthUserSchema, errors: [401, 409] });
registerRoute({ method: "post", path: "/auth/methods/apple", tag: T, summary: "Link Apple", auth: true, body: linkAppleBody, response: AuthUserSchema, errors: [401, 409] });
registerRoute({ method: "delete", path: "/auth/methods/{provider}", tag: T, summary: "Remove a login method", description: "The last remaining method cannot be removed.", auth: true, params: providerParams, response: AuthUserSchema, errors: [404, 409] });
registerRoute({ method: "delete", path: "/auth/account", tag: T, summary: "Delete my account", description: "Soft-delete + anonymize. Requires `confirm: \"DELETE\"` and the password if one is set.", auth: true, body: deleteAccountBody, errors: [400, 422] });
