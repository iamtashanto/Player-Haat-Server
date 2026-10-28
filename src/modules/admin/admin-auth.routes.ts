import { Router } from "express";
import { decodeJwt } from "jose";
import type { z } from "zod";
import { ok, valid } from "../../lib/http.js";
import { createRateLimiter, ipOnly } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import { z as zod } from "../../lib/zod.js";
import { registerRoute } from "../../lib/openapi.js";
import * as svc from "./admin-auth.service.js";
import { setRefreshCookie } from "./admin-auth.cookie.js";

type B<T extends z.ZodType> = z.infer<T>;
const challengeToken = zod.string().min(20).max(2000);
const setupBody = zod.strictObject({ challengeToken });
const enableBody = zod.strictObject({ challengeToken, code: zod.string().regex(/^\d{6}$/, "6-digit code") });
const verifyBody = zod
  .strictObject({ challengeToken, code: zod.string().regex(/^\d{6}$/, "6-digit code").optional(), backupCode: zod.string().trim().min(6).max(40).optional() })
  .refine((b) => (b.code === undefined) !== (b.backupCode === undefined), { message: "Send a code or a backup code", path: ["code"] });

/** Attempts are counted per admin account (read from the challenge), so a stolen password can't be used to guess codes. */
const perAdmin = (req: { body?: { challengeToken?: unknown } }) => {
  try {
    return `admin:${decodeJwt(String(req.body?.challengeToken ?? "")).sub ?? "?"}`;
  } catch {
    return "admin:?";
  }
};
const guess = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 8, keyGenerator: perAdmin });
const perIp = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 60, keyGenerator: ipOnly });

const ctxOf = (req: { get(h: string): string | undefined }) => ({ userAgent: req.get("user-agent") });

/**
 * The second half of the admin sign-in (password is `POST /admin/auth/login`). Unauthenticated by design: the
 * challenge token from the password step is the credential. On success a session starts: the access token goes in the
 * body, the refresh token only in the httpOnly cookie.
 */
export const adminAuthRoutes = Router();

adminAuthRoutes.post("/auth/2fa/setup", perIp, guess, validate({ body: setupBody }), async (req, res) => {
  ok(res, await svc.startSetup(valid<B<typeof setupBody>>(req).body.challengeToken));
});

adminAuthRoutes.post("/auth/2fa/enable", perIp, guess, validate({ body: enableBody }), async (req, res) => {
  const { body } = valid<B<typeof enableBody>>(req);
  const { session, backupCodes } = await svc.enable(body.challengeToken, body.code, ctxOf(req));
  setRefreshCookie(res, session.tokens.refreshToken);
  ok(res, { accessToken: session.tokens.accessToken, backupCodes });
});

adminAuthRoutes.post("/auth/2fa/verify", perIp, guess, validate({ body: verifyBody }), async (req, res) => {
  const { body } = valid<B<typeof verifyBody>>(req);
  const session = await svc.verify(body.challengeToken, { code: body.code, backupCode: body.backupCode }, ctxOf(req));
  setRefreshCookie(res, session.tokens.refreshToken);
  ok(res, { accessToken: session.tokens.accessToken });
});

const Obj = zod.record(zod.string(), zod.unknown());
const A = { tag: "Admin" } as const;
registerRoute({ method: "post", path: "/admin/auth/2fa/setup", ...A, summary: "Start two-factor setup (first sign-in)", description: "Needs the `challengeToken` from the password step. Returns the secret and an `otpauth://` URL for the authenticator app.", body: setupBody, response: Obj, errors: [401, 409, 422, 429] });
registerRoute({ method: "post", path: "/admin/auth/2fa/enable", ...A, summary: "Confirm the first code, turn two-factor on and sign in", description: "Returns the access token and eight one-time backup codes, shown only now. The refresh token is set as an httpOnly cookie.", body: enableBody, response: Obj, errors: [401, 409, 422, 429] });
registerRoute({ method: "post", path: "/admin/auth/2fa/verify", ...A, summary: "Finish sign-in with a code or a backup code", description: "A code can be used once. 8 attempts per 15 minutes per admin account.", body: verifyBody, response: Obj, errors: [401, 409, 422, 429] });
