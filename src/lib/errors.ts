/**
 * Stable machine-readable error codes. The mobile app maps these to bn/en strings,
 * so never rename one once shipped — add a new code instead.
 * Codes are grouped by module prefix; later phases append to this object.
 */
export const ErrorCode = {
  // generic
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  MALFORMED_JSON: "MALFORMED_JSON",
  CORS_NOT_ALLOWED: "CORS_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

  // auth (used from phase 2)
  AUTH_UNAUTHENTICATED: "AUTH_UNAUTHENTICATED",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  AUTH_ACCOUNT_SUSPENDED: "AUTH_ACCOUNT_SUSPENDED",
  AUTH_EMAIL_TAKEN: "AUTH_EMAIL_TAKEN",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_WRONG_PASSWORD: "AUTH_WRONG_PASSWORD",
  AUTH_PASSWORD_REQUIRED: "AUTH_PASSWORD_REQUIRED",
  AUTH_NO_EMAIL: "AUTH_NO_EMAIL",
  AUTH_INVALID_OTP: "AUTH_INVALID_OTP",
  AUTH_OTP_EXPIRED: "AUTH_OTP_EXPIRED",
  AUTH_OTP_TOO_MANY_ATTEMPTS: "AUTH_OTP_TOO_MANY_ATTEMPTS",
  AUTH_OTP_COOLDOWN: "AUTH_OTP_COOLDOWN",
  AUTH_OTP_LIMIT: "AUTH_OTP_LIMIT",
  AUTH_SMS_UNAVAILABLE: "AUTH_SMS_UNAVAILABLE",
  AUTH_EMAIL_ALREADY_VERIFIED: "AUTH_EMAIL_ALREADY_VERIFIED",
  AUTH_INVALID_REFRESH_TOKEN: "AUTH_INVALID_REFRESH_TOKEN",
  AUTH_REFRESH_EXPIRED: "AUTH_REFRESH_EXPIRED",
  AUTH_REFRESH_REUSED: "AUTH_REFRESH_REUSED",
  AUTH_INVALID_SOCIAL_TOKEN: "AUTH_INVALID_SOCIAL_TOKEN",
  AUTH_PROVIDER_NOT_CONFIGURED: "AUTH_PROVIDER_NOT_CONFIGURED",
  AUTH_PROVIDER_ALREADY_LINKED: "AUTH_PROVIDER_ALREADY_LINKED",
  AUTH_PROVIDER_NOT_LINKED: "AUTH_PROVIDER_NOT_LINKED",
  AUTH_LAST_LOGIN_METHOD: "AUTH_LAST_LOGIN_METHOD",
  AUTH_DELETE_NOT_CONFIRMED: "AUTH_DELETE_NOT_CONFIRMED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode | (string & {}),
    public readonly status: number,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }

  /** A 422 shaped exactly like a Zod failure, for rules that need the database to check. */
  static invalid(path: string, message: string) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 422, "Request validation failed", [{ path, code: "custom", message }]);
  }
  static badRequest(code: string, message?: string, details?: unknown) {
    return new AppError(code, 400, message, details);
  }
  static unauthorized(code: string = ErrorCode.AUTH_UNAUTHENTICATED, message?: string) {
    return new AppError(code, 401, message);
  }
  static forbidden(code: string = ErrorCode.AUTH_FORBIDDEN, message?: string) {
    return new AppError(code, 403, message);
  }
  static notFound(code: string = ErrorCode.NOT_FOUND, message?: string) {
    return new AppError(code, 404, message);
  }
  static conflict(code: string = ErrorCode.CONFLICT, message?: string, details?: unknown) {
    return new AppError(code, 409, message, details);
  }
}
