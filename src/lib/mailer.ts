import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transport: Transporter | undefined;

function getTransport(): Transporter {
  if (transport) return transport;
  if (env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587),
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  } else {
    // Dev/test without SMTP: don't send, just log the message (the code is in the text body).
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const info = await getTransport().sendMail({ from: env.MAIL_FROM, ...msg });
  if (!env.SMTP_HOST) logger.info({ to: msg.to, subject: msg.subject, text: msg.text }, "email (not sent: no SMTP_HOST)");
  else logger.debug({ messageId: info.messageId }, "email sent");
}
