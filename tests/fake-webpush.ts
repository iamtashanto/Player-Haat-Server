import type { WebPushProvider, WebSendResult, WebSub } from "../src/lib/webpush/index.js";

/** Records every browser push instead of calling a push service. */
class FakeWebPush implements WebPushProvider {
  enabled = true;
  publicKey: string | null = "BFakePublicKeyForTests";
  sent: Array<{ sub: WebSub; payload: { title: string; body: string; link: string; data: Record<string, string> } }> = [];
  gone = new Set<string>();
  failing = new Set<string>();

  reset() {
    this.enabled = true;
    this.sent = [];
    this.gone.clear();
    this.failing.clear();
  }

  async send(sub: WebSub, payload: { title: string; body: string; link: string; data: Record<string, string> }): Promise<WebSendResult> {
    if (this.failing.has(sub.endpoint)) throw new Error("web push failed (500)");
    if (this.gone.has(sub.endpoint)) return "gone";
    this.sent.push({ sub, payload });
    return "ok";
  }

  to(endpoint: string) {
    return this.sent.filter((s) => s.sub.endpoint === endpoint).map((s) => s.payload);
  }
}

export const fakeWebPush = new FakeWebPush();
