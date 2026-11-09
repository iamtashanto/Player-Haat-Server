export interface PushMessage {
  title: string;
  body: string;
  /** FCM data payload — every value must be a string. */
  data: Record<string, string>;
  /** Android notification channel (games, messages, recruitment, system). */
  channel?: string;
  /** Absolute URL a web-push click opens. */
  webLink?: string;
}

export interface PushResult {
  /** Tokens the provider says are dead (app uninstalled / token rotated); the caller deletes them. */
  invalidTokens: string[];
}

export interface PushProvider {
  readonly enabled: boolean;
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}
