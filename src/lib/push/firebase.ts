import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { PushMessage, PushProvider, PushResult } from "./types.js";

const FCM_BATCH = 500; // sendEachForMulticast limit
const DEAD_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

/** `FIREBASE_SERVICE_ACCOUNT` is either a path to the JSON key or the JSON itself. */
function loadServiceAccount(value: string) {
  const json = value.trim().startsWith("{") ? value : readFileSync(value, "utf8");
  return JSON.parse(json);
}

export class FirebasePush implements PushProvider {
  readonly enabled = true;

  constructor(serviceAccount: string) {
    // Throws on a bad path / bad JSON so a broken deploy fails at boot, not on the first notification.
    const credential = cert(loadServiceAccount(serviceAccount));
    if (getApps().length === 0) initializeApp({ credential });
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    const invalidTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += FCM_BATCH) {
      const batch = tokens.slice(i, i + FCM_BATCH);
      const res = await getMessaging().sendEachForMulticast({
        tokens: batch,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: "high", notification: { channelId: "playerhaat_default" } },
        apns: { payload: { aps: { sound: "default" } } },
      });
      res.responses.forEach((r, idx) => {
        if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) invalidTokens.push(batch[idx]!);
      });
    }
    return { invalidTokens };
  }
}
