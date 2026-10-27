import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectErrorCodes, renderErrorDocs } from "../scripts/gen-error-docs.js";

describe("docs/ERROR_CODES.md", () => {
  it("is up to date with the source (run `npm run docs:errors` after adding or changing a code)", () => {
    const committed = readFileSync(new URL("../docs/ERROR_CODES.md", import.meta.url), "utf8");
    expect(committed).toBe(renderErrorDocs());
  });

  it("finds codes from every way the code raises them", () => {
    const codes = new Map(collectErrorCodes().map((e) => [e.code, e]));
    expect(codes.get("REQUEST_FILLED")?.status).toBe(409); // AppError.conflict("…")
    expect(codes.get("AUTH_INVALID_OTP")?.status).toBe(400); // AppError.badRequest(ErrorCode.X)
    expect(codes.get("MEDIA_TOO_LARGE")?.status).toBe(413); // new AppError("…", 413)
    expect(codes.get("PROFILE_ALREADY_HIDDEN")?.status).toBe(409); // ternary in admin service
    expect(codes.get("AUTH_UNAUTHENTICATED")?.status).toBe(401); // helper default
    expect(codes.get("RATE_LIMITED")?.status).toBe(429); // shared middleware
    expect(codes.size).toBeGreaterThan(80);
  });

  it("every code is SCREAMING_SNAKE and has a message", () => {
    for (const e of collectErrorCodes()) {
      expect(e.code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
      expect(e.message, e.code).not.toBe("");
    }
  });
});
