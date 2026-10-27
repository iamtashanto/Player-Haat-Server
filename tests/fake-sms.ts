import { AppError } from "../src/lib/errors.js";
import type { SmsProvider } from "../src/lib/sms/types.js";

/** Records every text instead of sending it. */
class FakeSms implements SmsProvider {
  enabled = true;
  sent: Array<{ to: string; text: string }> = [];
  fail = false;

  reset() {
    this.enabled = true;
    this.sent = [];
    this.fail = false;
  }

  async send(to: string, text: string) {
    if (this.fail) throw new AppError("SMS_SEND_FAILED", 502, "Could not send the SMS right now");
    this.sent.push({ to, text });
  }

  /** The 6-digit code in the latest text to `to`. */
  lastCode(to: string): string {
    const m = [...this.sent].reverse().find((s) => s.to === to)?.text.match(/\b(\d{6})\b/);
    if (!m) throw new Error(`No SMS sent to ${to}`);
    return m[1]!;
  }
}
export const fakeSms = new FakeSms();
