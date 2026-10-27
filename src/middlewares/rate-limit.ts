import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { env } from "../config/env.js";
import { ErrorCode } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";

/** Tests flip this on to exercise the limiters; otherwise they're off under NODE_ENV=test. */
export const rateLimitControl = { forceEnabled: false };
const disabled = () => !rateLimitControl.forceEnabled && (env.isTest || !env.RATE_LIMIT_ENABLED);

export const ipOnly = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? "")}`;
/**
 * Signed-in callers are counted per *user*, everyone else per IP. Mobile carriers in Bangladesh put
 * thousands of phones behind one address (CGNAT), so a per-IP budget would throttle innocent users
 * the moment a few of them share an exit IP.
 */
const callerKey = (req: Request) => (req.callerId ? `u:${req.callerId}` : ipOnly(req));

/**
 * Factory so each route group picks its own budget. Counters live in this process's memory: with N
 * PM2 workers a budget is effectively up to N× larger. Nginx's `limit_req` (shared across workers) is
 * the exact first line of defence for credential endpoints — see deploy/nginx.
 */
export const createRateLimiter = (opts: { windowMs: number; limit: number } & Partial<Options>) =>
  rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: callerKey,
    skip: disabled,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: ErrorCode.RATE_LIMITED, message: "Too many requests, slow down." } });
    },
    ...opts,
  });

/** Bucket per IP *and* target email, so one attacker can't lock a victim out from everywhere, nor spray one IP across accounts. */
export const ipAndEmailKey = (req: Request) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return `${ipOnly(req)}|${email}`;
};

/** Bucket per IP and phone number (digits only, so '+880 17…' and '017…' share a bucket). */
export const ipAndPhoneKey = (req: Request) => {
  const digits = typeof req.body?.phone === "string" ? req.body.phone.replace(/\D/g, "").replace(/^(880|0)/, "") : "";
  return `${ipOnly(req)}|${digits}`;
};

/**
 * Works out who is calling *before* routing, from the signature-checked access token alone (no DB hit),
 * so every limiter downstream can key on the user. A missing, expired or forged token simply means the
 * caller is counted by IP; real authentication still happens later in `requireAuth`.
 */
export const identifyCaller: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.callerId = (await verifyAccessToken(header.slice(7).trim())).userId;
    } catch {
      /* anonymous */
    }
  }
  next();
};

export interface ApiLimits {
  /** Per IP, for everyone, signed in or not. Deliberately generous (shared carrier IPs). */
  ipPer15Min: number;
  /** Per signed-in user. */
  callerReadsPer15Min: number;
  callerWritesPer15Min: number;
}
export const DEFAULT_API_LIMITS: ApiLimits = { ipPer15Min: 1500, callerReadsPer15Min: 1200, callerWritesPer15Min: 300 };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The blanket limits for the whole API, applied before any router. Route-level limiters stack on top. */
export function createApiLimits(limits: ApiLimits = DEFAULT_API_LIMITS): RequestHandler[] {
  const window = 15 * 60 * 1000;
  const perIp = createRateLimiter({ windowMs: window, limit: limits.ipPer15Min, keyGenerator: ipOnly });
  const reads = createRateLimiter({ windowMs: window, limit: limits.callerReadsPer15Min });
  const writes = createRateLimiter({ windowMs: window, limit: limits.callerWritesPer15Min });
  const perCaller: RequestHandler = (req, res, next) => (req.callerId ? (WRITE_METHODS.has(req.method) ? writes : reads)(req, res, next) : next());
  return [identifyCaller, perIp, perCaller];
}
