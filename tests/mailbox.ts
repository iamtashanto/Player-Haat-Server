import type { MailMessage } from "../src/lib/mailer.js";

/** Every email "sent" during a test (the mailer is mocked in setup.ts). */
export const mailbox: MailMessage[] = [];

export const mailsTo = (email: string) => mailbox.filter((m) => m.to === email);

/** The 6-digit code from the most recent email to `email`. */
export function lastCode(email: string): string {
  const mail = mailsTo(email).at(-1);
  const code = mail?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`No code email sent to ${email}`);
  return code;
}
