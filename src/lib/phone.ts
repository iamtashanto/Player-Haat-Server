import { BD_PHONE_E164 } from "../config/constants.js";

/**
 * Normalizes a Bangladesh mobile number to E.164 (+8801XXXXXXXXX).
 * Accepts 01712345678, 8801712345678, +880 1712-345678, 00880… Returns null if it isn't a valid BD mobile.
 */
export function normalizeBdPhone(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith("880")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  // digits is now the national number without the trunk 0: 1XXXXXXXXX
  const e164 = `+880${digits}`;
  return BD_PHONE_E164.test(e164) ? e164 : null;
}
