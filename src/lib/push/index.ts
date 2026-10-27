import { env } from "../../config/env.js";
import { logger } from "../logger.js";
import { FirebasePush } from "./firebase.js";
import type { PushProvider } from "./types.js";

/** Used when Firebase isn't configured (local dev): notifications still reach the in-app inbox. */
const noop: PushProvider = {
  enabled: false,
  async send(tokens, message) {
    logger.debug({ devices: tokens.length, title: message.title }, "push skipped (FIREBASE_SERVICE_ACCOUNT not set)");
    return { invalidTokens: [] };
  },
};

export const push: PushProvider = env.FIREBASE_SERVICE_ACCOUNT ? new FirebasePush(env.FIREBASE_SERVICE_ACCOUNT) : noop;
export type { PushMessage, PushProvider, PushResult } from "./types.js";
