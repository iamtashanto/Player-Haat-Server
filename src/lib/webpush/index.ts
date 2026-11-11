import webpush from "web-push";
import { env } from "../../config/env.js";

export interface WebSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}
/** "gone" = the push service says the subscription no longer exists (404/410): delete it. */
export type WebSendResult = "ok" | "gone";

export interface WebPushProvider {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  send(sub: WebSub, payload: { title: string; body: string; link: string; data: Record<string, string> }): Promise<WebSendResult>;
}

const off: WebPushProvider = {
  enabled: false,
  publicKey: null,
  async send() {
    return "ok";
  },
};

function create(): WebPushProvider {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
  if (!pub || !priv) return off;
  webpush.setVapidDetails(subject ?? "mailto:admin@playerhaat.com", pub, priv);
  return {
    enabled: true,
    publicKey: pub,
    async send(sub, payload) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" });
        return "ok";
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return "gone";
        throw new Error(`web push failed${status ? ` (${status})` : ""}`); // never the endpoint or keys
      }
    },
  };
}

export const webPush: WebPushProvider = create();
