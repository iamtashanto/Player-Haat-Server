import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Boots src/config/env.ts in a child process with the given variables and reports whether it started. */
function boot(env: Record<string, string>) {
  const result = spawnSync("npx", ["tsx", "-e", 'import("./src/config/env.ts").then(() => console.log("BOOT_OK"))'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
  });
  return { ok: result.stdout.includes("BOOT_OK"), stderr: result.stderr };
}

const prod = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "a-real-secret-that-is-long-enough-1234567890",
  SMTP_HOST: "smtp.example.com",
  CORS_ORIGINS: "https://playerhaat.com",
};

describe("production config is validated at boot (fail fast)", () => {
  it("accepts a complete production environment", () => {
    expect(boot(prod).ok).toBe(true);
  });

  it.each([
    ["the example JWT secret", { JWT_ACCESS_SECRET: "change-me-change-me-change-me-change-me" }, "JWT_ACCESS_SECRET"],
    ["a short JWT secret", { JWT_ACCESS_SECRET: "short" }, "JWT_ACCESS_SECRET"],
    ["a missing SMTP host", { SMTP_HOST: "" }, "SMTP_HOST"],
    ["no CORS origins", { CORS_ORIGINS: "" }, "CORS_ORIGINS"],
    ["rate limiting switched off", { RATE_LIMIT_ENABLED: "false" }, "RATE_LIMIT_ENABLED"],
    ["a malformed database url", { DATABASE_URL: "not-a-url" }, "DATABASE_URL"],
  ])("refuses to start with %s and names the variable", (_label, override, variable) => {
    const res = boot({ ...prod, ...override });
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain(variable);
  });

  it("allows rate limiting to be disabled outside production (load tests)", () => {
    expect(boot({ ...prod, NODE_ENV: "development", RATE_LIMIT_ENABLED: "false" }).ok).toBe(true);
  });
});
