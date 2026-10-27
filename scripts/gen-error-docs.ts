/**
 * Builds docs/ERROR_CODES.md by reading the source, so the reference can't drift from the code.
 *   npm run docs:errors        (a test fails when the committed file is out of date)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

export interface ErrorEntry {
  code: string;
  status: number;
  message: string;
  where: Set<string>;
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });

const STATUS: Record<string, number> = { badRequest: 400, unauthorized: 401, forbidden: 403, notFound: 404, conflict: 409 };
const DEFAULT_CODE: Record<string, string> = { unauthorized: "AUTH_UNAUTHENTICATED", forbidden: "AUTH_FORBIDDEN", notFound: "NOT_FOUND", conflict: "CONFLICT" };

/** Codes raised by shared plumbing (error handler, rate limiter, validation) rather than a module. */
const GENERIC: Array<[string, number, string]> = [
  ["VALIDATION_ERROR", 422, "Request validation failed (details lists each field)"],
  ["NOT_FOUND", 404, "Resource not found"],
  ["ROUTE_NOT_FOUND", 404, "No such endpoint"],
  ["CONFLICT", 409, "Resource already exists"],
  ["RATE_LIMITED", 429, "Too many requests, slow down."],
  ["PAYLOAD_TOO_LARGE", 413, "Request body too large"],
  ["MALFORMED_JSON", 400, "Malformed JSON body"],
  ["INTERNAL_ERROR", 500, "Internal server error"],
  ["SERVICE_UNAVAILABLE", 503, "Database unreachable"],
];

const cleanMessage = (raw: string | undefined) => {
  if (!raw) return "";
  const body = raw.slice(1, -1).replace(/\\(.)/g, "$1");
  const cut = body.indexOf("${");
  return (cut === -1 ? body : `${body.slice(0, cut).trim()}…`).replace(/\|/g, "\\|");
};

export function collectErrorCodes(): ErrorEntry[] {
  const found = new Map<string, ErrorEntry>();
  const add = (code: string, status: number, message: string, file: string) => {
    const e = found.get(code) ?? { code, status, message, where: new Set<string>() };
    if (!e.message && message) e.message = message;
    e.where.add(file);
    found.set(code, e);
  };

  const STR = '"(?:[^"\\\\]|\\\\.)*"|`[^`]*`';
  const codeArg = '(?:ErrorCode\\.(\\w+)|"([A-Z][A-Z0-9_]+)")';
  const newErr = new RegExp(`new AppError\\(\\s*${codeArg}\\s*,\\s*(\\d{3})(?:\\s*,\\s*(${STR}))?`, "g");
  const helper = new RegExp(`AppError\\.(badRequest|unauthorized|forbidden|notFound|conflict)\\(\\s*(?:${codeArg})?(?:\\s*,\\s*(${STR}))?`, "g");
  const ternary = new RegExp(`AppError\\.(badRequest|forbidden|notFound|conflict)\\(\\s*[\\w.]+\\s*\\?\\s*"([A-Z][A-Z0-9_]+)"\\s*:\\s*"([A-Z][A-Z0-9_]+)"`, "g");
  const dyn = new RegExp(`AppError\\(\\s*([A-Za-z_.]+)\\s*,\\s*(\\d{3})`, "g");

  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(SRC, file);
    if (rel === "lib/errors.ts") continue;
    for (const m of text.matchAll(newErr)) add(m[1] ?? m[2]!, Number(m[3]), cleanMessage(m[4]), rel);
    for (const m of text.matchAll(helper)) {
      const code = m[2] ?? m[3] ?? DEFAULT_CODE[m[1]!];
      if (code) add(code, STATUS[m[1]!]!, cleanMessage(m[4]), rel);
    }
    for (const m of text.matchAll(ternary)) {
      add(m[2]!, STATUS[m[1]!]!, "", rel);
      add(m[3]!, STATUS[m[1]!]!, "", rel);
    }
    // anything built from a variable can't be read statically — fail loudly rather than silently omit it
    for (const m of text.matchAll(dyn)) {
      if (!/^(ErrorCode\.\w+)$/.test(m[1]!) && !/^"/.test(m[1]!) && rel !== "lib/errors.ts") throw new Error(`Dynamic AppError code in ${rel}: ${m[0]} — use a literal so the docs can list it`);
    }
  }
  for (const [code, status, message] of GENERIC) add(code, status, message, "(shared middleware)");
  // an auth message that never carries its own text
  const fallbacks: Record<string, string> = {
    AUTH_UNAUTHENTICATED: "Missing, malformed or invalid access token",
    AUTH_TOKEN_EXPIRED: "Access token expired — refresh it and retry",
    AUTH_FORBIDDEN: "Signed in, but not allowed to do this",
    AUTH_ACCOUNT_SUSPENDED: "The account is suspended",
    AUTH_INVALID_REFRESH_TOKEN: "Unknown or logged-out refresh token",
    AUTH_REFRESH_EXPIRED: "Refresh token expired — sign in again",
    AUTH_EMAIL_ALREADY_VERIFIED: "Email is already verified",
    AUTH_INVALID_CREDENTIALS: "Wrong email or password",
    AUTH_REFRESH_REUSED: "Refresh token was already used; all sessions for this login were revoked",
    MEDIA_INVALID_UPLOAD: "Malformed multipart upload (details in the message)",
    PROFILE_ALREADY_HIDDEN: "Already hidden",
    PROFILE_NOT_HIDDEN: "Not hidden",
    REQUEST_ALREADY_HIDDEN: "Already hidden",
    REQUEST_NOT_HIDDEN: "Not hidden",
  };
  for (const e of found.values()) if (!e.message && fallbacks[e.code]) e.message = fallbacks[e.code]!;
  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function renderErrorDocs(): string {
  const entries = collectErrorCodes();
  const groups = new Map<string, ErrorEntry[]>();
  for (const e of entries) {
    const prefix = e.code.split("_")[0]!;
    groups.set(prefix, [...(groups.get(prefix) ?? []), e]);
  }
  const lines = [
    "# Error codes",
    "",
    "<!-- GENERATED by `npm run docs:errors` from the source. Do not edit by hand; a test fails if this is stale. -->",
    "",
    "Every error response has this shape — the app should translate `error.code`, never show `message`:",
    "",
    "```json",
    '{ "error": { "code": "REQUEST_FILLED", "message": "This request is already filled", "details": null } }',
    "```",
    "",
    "`VALIDATION_ERROR` (422) carries `details: [{ path, code, message }]`, one per bad field.",
    "",
    `${entries.length} codes. Messages are developer-facing English and may change; **codes are stable**.`,
    "",
  ];
  for (const [prefix, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${prefix}`, "", "| Code | HTTP | Developer message | Raised in |", "|---|---|---|---|");
    for (const e of list) lines.push(`| \`${e.code}\` | ${e.status} | ${e.message || "—"} | ${[...e.where].sort().map((w) => `\`${w}\``).join(", ")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("gen-error-docs.ts")) {
  writeFileSync(join(ROOT, "docs/ERROR_CODES.md"), renderErrorDocs());
  console.log(`wrote docs/ERROR_CODES.md (${collectErrorCodes().length} codes)`);
}
