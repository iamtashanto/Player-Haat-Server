import { normalizeBdPhone } from "../../lib/phone.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const phone = z
  .string()
  .trim()
  .max(25)
  .transform((v, ctx) => {
    const normalized = normalizeBdPhone(v);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Not a valid Bangladesh mobile number" });
      return z.NEVER;
    }
    return normalized;
  })
  .openapi({ type: "string", example: "01712345678", description: "Stored as E.164 (+8801712345678)." });

// strictObject: unknown keys (role, status, email…) are a 422, not silently ignored — no mass assignment.
export const updateMeBody = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    birthYear: z
      .number()
      .int()
      .min(1940)
      .refine((y) => y <= new Date().getFullYear() - 8, "Too young")
      .nullable(),
    locale: z.enum(["bn", "en"]),
    phone: phone.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field");

const binary = z.string().openapi({ type: "string", format: "binary" });

const MeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    phone: z.string().nullable(),
    phoneVerified: z.boolean(),
    avatarUrl: z.string().nullable(),
    locale: z.enum(["bn", "en"]),
    role: z.enum(["PLAYER", "RECRUITER", "ADMIN"]),
    birthYear: z.number().nullable(),
    hasPlayerProfile: z.boolean(),
    hasRecruiterProfile: z.boolean(),
    onboardingStep: z.enum(["PLAYER_PROFILE", "RECRUITER_PROFILE"]).nullable().openapi({ description: "The next role-specific onboarding step, or null when the account is set up." }),
    captainRating: z.object({ average: z.number(), count: z.number() }),
    createdAt: z.string().datetime(),
  })
  .openapi("Me");

const T = "Users";
registerRoute({ method: "get", path: "/users/me", tag: T, summary: "My account", auth: true, response: MeSchema });
registerRoute({
  method: "patch",
  path: "/users/me",
  tag: T,
  summary: "Update my account (name, birth year, locale, phone)",
  description: "Email and login methods are managed under /auth. The phone is stored unverified.",
  auth: true,
  body: updateMeBody,
  response: MeSchema,
  errors: [409, 422],
});
registerRoute({
  method: "put",
  path: "/users/me/avatar",
  tag: T,
  summary: "Upload my avatar",
  description: "multipart/form-data, field `file`. Face-cropped to 512×512; the previous avatar is deleted.",
  auth: true,
  multipart: z.object({ file: binary }),
  response: MeSchema,
  errors: [413, 415, 422, 502, 503],
});
registerRoute({ method: "delete", path: "/users/me/avatar", tag: T, summary: "Remove my avatar", auth: true, response: MeSchema });
registerRoute({
  method: "delete",
  path: "/users/me",
  tag: T,
  summary: "Delete my account",
  description: "Same as DELETE /auth/account: soft-delete + anonymize, all images purged.",
  auth: true,
  body: z.object({ password: z.string().max(128).optional(), confirm: z.literal("DELETE") }),
  errors: [400, 422],
});
