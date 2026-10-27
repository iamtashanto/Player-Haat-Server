export const OTP = {
  digits: 6,
  maxAttempts: 5,
  cooldownSec: 60,
  /** Max texts to one number per rolling hour. */
  phonePerHour: 5,
  ttlMinutes: { EMAIL_VERIFY: 30, PASSWORD_RESET: 15, PHONE_OTP: 5 },
} as const;

export const REFRESH_REUSE_MESSAGE = "Refresh token was already used; all sessions for this login were revoked";
