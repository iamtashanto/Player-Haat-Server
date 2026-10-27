export interface SmsProvider {
  readonly enabled: boolean;
  /** `to` is E.164 (+8801XXXXXXXXX). Throws on delivery failure. */
  send(to: string, text: string): Promise<void>;
}
