import { env } from "../../config/env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { SmsProvider } from "./types.js";

/** Local development: nothing is sent, the message (with the code) is logged. */
const consoleSms: SmsProvider = {
  enabled: true,
  async send(to, text) {
    logger.info({ to, text }, "sms (not sent: SMS_HTTP_URL_TEMPLATE not set)");
  },
};

/**
 * Generic HTTP gateway (works with the common Bangladeshi bulk-SMS APIs that take a GET):
 *   SMS_HTTP_URL_TEMPLATE="https://gateway.example/api?key=SECRET&to={to}&msg={text}"
 * `{to}` is the number without "+" (8801XXXXXXXXX) and `{text}` the URL-encoded message.
 * Any 2xx response counts as delivered.
 */
function httpSms(template: string): SmsProvider {
  return {
    enabled: true,
    async send(to, text) {
      const url = template.replace("{to}", encodeURIComponent(to.replace(/^\+/, ""))).replace("{text}", encodeURIComponent(text));
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!res || !res.ok) {
        logger.error({ status: res?.status }, "sms gateway rejected the message");
        throw new AppError("SMS_SEND_FAILED", 502, "Could not send the SMS right now");
      }
    },
  };
}

const disabled: SmsProvider = {
  enabled: false,
  async send() {
    throw new AppError("AUTH_PROVIDER_NOT_CONFIGURED", 503, "Phone sign-in is not available");
  },
};

export const sms: SmsProvider = !env.PHONE_AUTH_ENABLED
  ? disabled
  : env.SMS_HTTP_URL_TEMPLATE
    ? httpSms(env.SMS_HTTP_URL_TEMPLATE)
    : env.isProd
      ? disabled
      : consoleSms;
export type { SmsProvider } from "./types.js";
