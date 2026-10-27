import type { PushMessage, PushProvider, PushResult } from "../src/lib/push/types.js";

/** Records every push instead of calling FCM. */
class FakePush implements PushProvider {
  enabled = true;
  sent: Array<{ tokens: string[]; message: PushMessage }> = [];
  deadTokens = new Set<string>();
  fail = false;

  reset() {
    this.sent = [];
    this.deadTokens.clear();
    this.fail = false;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    if (this.fail) throw new Error("FCM unavailable");
    this.sent.push({ tokens: [...tokens], message });
    return { invalidTokens: tokens.filter((t) => this.deadTokens.has(t)) };
  }

  /** Pushes delivered to a given device token. */
  to(token: string) {
    return this.sent.filter((s) => s.tokens.includes(token)).map((s) => s.message);
  }
}

export const fakePush = new FakePush();
