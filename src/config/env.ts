import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/** "a, b ,c" -> ["a","b","c"]; empty string -> [] */
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CORS_ORIGINS: csv,
    TRUST_PROXY: bool.default(false),
    PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
    DOCS_ENABLED: bool.optional(),
    JOBS_ENABLED: bool.optional(),
    // Only for load tests / debugging. Refused in production.
    RATE_LIMIT_ENABLED: bool.default(true),

    DATABASE_URL: z.string().url(),

    // Auth — consumed from phase 2, validated now so a bad deploy fails at boot, not at first login.
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    GOOGLE_CLIENT_IDS: csv,
    APPLE_CLIENT_IDS: csv,

    // Third-party integrations — optional until the phase that uses them; each service
    // checks for its own config and throws a clear error when used while unconfigured.
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,

    SMTP_HOST: optionalString,
    SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    MAIL_FROM: z.string().default("PlayerHaat <no-reply@playerhaat.local>"),

    FIREBASE_SERVICE_ACCOUNT: optionalString,

    // Phone-OTP sign-in. In production it needs a gateway; without one the endpoints answer 503.
    PHONE_AUTH_ENABLED: bool.default(true),
    SMS_HTTP_URL_TEMPLATE: optionalString,
    /** Hard ceiling on OTP texts per rolling 24h across all users: a cost cap against SMS-pumping fraud. */
    SMS_DAILY_LIMIT: z.coerce.number().int().positive().default(2000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (env.JWT_ACCESS_SECRET.startsWith("change-me")) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_ACCESS_SECRET"],
        message: "Refusing to start in production with the example JWT secret",
      });
    }
    if (!env.RATE_LIMIT_ENABLED) {
      ctx.addIssue({ code: "custom", path: ["RATE_LIMIT_ENABLED"], message: "Rate limiting can't be disabled in production" });
    }
    if (!env.SMTP_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_HOST"],
        message: "SMTP_HOST is required in production (verification and reset emails)",
      });
    }
    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "CORS_ORIGINS must list the allowed web origins in production",
      });
    }
  });

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    // Logger isn't built yet (it depends on env), so write straight to stderr and exit.
    process.stderr.write(`Invalid environment configuration:\n${lines.join("\n")}\n`);
    process.exit(1);
  }
  const env = parsed.data;
  return {
    ...env,
    isProd: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    // Swagger UI is on by default everywhere except production.
    DOCS_ENABLED: env.DOCS_ENABLED ?? env.NODE_ENV !== "production",
    // Background jobs (rating reminders) run in every environment except tests.
    JOBS_ENABLED: env.JOBS_ENABLED ?? env.NODE_ENV !== "test",
  };
}

export const env = load();
export type Env = typeof env;
