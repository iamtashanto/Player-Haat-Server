import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { createRateLimiter, ipAndEmailKey, ipAndPhoneKey, ipOnly } from "../../middlewares/rate-limit.js";
import { validate } from "../../middlewares/validate.js";
import * as c from "./auth.controller.js";
import * as s from "./auth.schema.js";

const MIN = 60 * 1000;
// Budgets per route (on top of the global per-IP limiter). Credential endpoints are the tightest.
const limits = {
  register: createRateLimiter({ windowMs: 60 * MIN, limit: 30 }), // per IP; carriers share addresses, so not too tight
  login: createRateLimiter({ windowMs: 15 * MIN, limit: 10, keyGenerator: ipAndEmailKey }),
  verifyEmail: createRateLimiter({ windowMs: 15 * MIN, limit: 10, keyGenerator: ipAndEmailKey }),
  forgot: createRateLimiter({ windowMs: 60 * MIN, limit: 5, keyGenerator: ipAndEmailKey }),
  reset: createRateLimiter({ windowMs: 15 * MIN, limit: 10, keyGenerator: ipAndEmailKey }),
  phoneRequest: createRateLimiter({ windowMs: 60 * MIN, limit: 5, keyGenerator: ipAndPhoneKey }),
  phoneRequestIp: createRateLimiter({ windowMs: 60 * MIN, limit: 40, keyGenerator: ipOnly }), // shared carrier IPs: generous, but a hard stop on SMS pumping
  phoneVerify: createRateLimiter({ windowMs: 15 * MIN, limit: 10, keyGenerator: ipAndPhoneKey }),
  social: createRateLimiter({ windowMs: 15 * MIN, limit: 30 }),
  refresh: createRateLimiter({ windowMs: 15 * MIN, limit: 60 }),
  sensitive: createRateLimiter({ windowMs: 15 * MIN, limit: 10 }), // password change, delete account, resend
};

export const authRoutes = Router();

authRoutes.post("/register", limits.register, validate({ body: s.registerBody }), c.register);
authRoutes.post("/login", limits.login, validate({ body: s.loginBody }), c.login);
authRoutes.post("/phone/request", limits.phoneRequestIp, limits.phoneRequest, validate({ body: s.phoneRequestBody }), c.phoneRequest);
authRoutes.post("/phone/verify", limits.phoneVerify, validate({ body: s.phoneVerifyBody }), c.phoneVerify);
authRoutes.post("/google", limits.social, validate({ body: s.googleBody }), c.google);
authRoutes.post("/apple", limits.social, validate({ body: s.appleBody }), c.apple);

authRoutes.post("/refresh", limits.refresh, validate({ body: s.refreshBody }), c.refresh);
authRoutes.post("/logout", limits.refresh, validate({ body: s.logoutBody }), c.logout);
authRoutes.post("/logout-all", requireAuth, c.logoutAll);

authRoutes.post("/verify-email", limits.verifyEmail, validate({ body: s.verifyEmailBody }), c.verifyEmail);
authRoutes.post("/resend-verification", requireAuth, limits.sensitive, c.resendVerification);
authRoutes.post("/forgot-password", limits.forgot, validate({ body: s.forgotPasswordBody }), c.forgotPassword);
authRoutes.post("/reset-password", limits.reset, validate({ body: s.resetPasswordBody }), c.resetPassword);

authRoutes.put("/password", requireAuth, limits.sensitive, validate({ body: s.setPasswordBody }), c.setPassword);
authRoutes.get("/methods", requireAuth, c.listMethods);
authRoutes.post("/methods/phone", requireAuth, limits.phoneVerify, validate({ body: s.linkPhoneBody }), c.linkPhone);
authRoutes.post("/methods/google", requireAuth, limits.social, validate({ body: s.linkGoogleBody }), c.linkGoogle);
authRoutes.post("/methods/apple", requireAuth, limits.social, validate({ body: s.linkAppleBody }), c.linkApple);
authRoutes.delete("/methods/:provider", requireAuth, limits.sensitive, validate({ params: s.providerParams }), c.unlinkMethod);

authRoutes.delete("/account", requireAuth, limits.sensitive, validate({ body: s.deleteAccountBody }), c.deleteAccount);
