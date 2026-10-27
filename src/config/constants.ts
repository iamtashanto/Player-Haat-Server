export const API_PREFIX = "/api/v1";

export const BODY_LIMIT = "100kb"; // JSON bodies; image uploads go through multer with their own 5 MB cap

export const PAGINATION = {
  defaultLimit: 20,
  maxLimit: 50,
} as const;

/** Bangladesh mobile numbers: +8801[3-9]XXXXXXXX once normalized. */
export const BD_PHONE_E164 = /^\+8801[3-9]\d{8}$/;
