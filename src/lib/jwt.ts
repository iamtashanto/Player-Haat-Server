import type { UserRole } from "@prisma/client";
import { SignJWT, errors, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { AppError, ErrorCode } from "./errors.js";

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = "playerhaat-api";

export interface AccessClaims {
  userId: string;
  role: UserRole;
}

const ROLES: readonly UserRole[] = ["PLAYER", "RECRUITER", "ADMIN"];

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MIN}m`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("missing sub");
    return { userId: payload.sub, role: ROLES.find((r) => r === payload.role) ?? "PLAYER" };
  } catch (err) {
    // The app uses TOKEN_EXPIRED to decide "refresh and retry" vs "send to login".
    if (err instanceof errors.JWTExpired) throw AppError.unauthorized(ErrorCode.AUTH_TOKEN_EXPIRED);
    throw AppError.unauthorized(ErrorCode.AUTH_UNAUTHENTICATED);
  }
}
