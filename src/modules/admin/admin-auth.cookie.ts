import type { Request, Response } from "express";
import { env } from "../../config/env.js";

/** The admin refresh token lives only in an httpOnly cookie scoped to the auth endpoints; scripts on the page never see it. */
export const REFRESH_COOKIE = "ph_admin_refresh";
const PATH = "/api/v1/admin/auth";

export function parseCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

export function setRefreshCookie(res: Response, token: string, maxAgeMs = env.REFRESH_TOKEN_TTL_DAYS * 86_400_000) {
  res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure: env.isProd, sameSite: "lax", path: PATH, maxAge: maxAgeMs });
}

export const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, { path: PATH });
