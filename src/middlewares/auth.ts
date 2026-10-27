import type { UserRole } from "@prisma/client";
import type { RequestHandler } from "express";
import { AppError, ErrorCode } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

/**
 * Requires `Authorization: Bearer <access token>`. The status and role are re-read from the DB on
 * every request (one indexed PK lookup) so suspensions, deletions and role changes take effect
 * immediately instead of waiting out the 15-minute token.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  // Already authenticated earlier in this request (e.g. a role guard mounted on the parent router).
  if (req.auth) return next();
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) throw AppError.unauthorized(ErrorCode.AUTH_UNAUTHENTICATED);

  const claims = await verifyAccessToken(token);
  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, role: true, status: true },
  });
  if (!user || user.status === "DELETED") throw AppError.unauthorized(ErrorCode.AUTH_UNAUTHENTICATED);
  if (user.status === "SUSPENDED") throw AppError.forbidden(ErrorCode.AUTH_ACCOUNT_SUSPENDED);

  req.auth = { userId: user.id, role: user.role };
  next();
};

/** Use after `requireAuth`. The caller's role must be one of `roles`; otherwise 403. */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw AppError.forbidden(ErrorCode.AUTH_FORBIDDEN);
    next();
  };

/** Everything the mobile app talks to: players and recruiters. Admins use the dashboard API only. */
export const requireAppUser: RequestHandler[] = [requireAuth, requireRole("PLAYER", "RECRUITER")];
export const requirePlayer: RequestHandler[] = [requireAuth, requireRole("PLAYER")];
export const requireRecruiter: RequestHandler[] = [requireAuth, requireRole("RECRUITER")];

/** Controllers call this to get the caller's id; never trust a client-sent userId. */
export function authUser(req: Express.Request) {
  if (!req.auth) throw AppError.unauthorized(ErrorCode.AUTH_UNAUTHENTICATED);
  return req.auth;
}
