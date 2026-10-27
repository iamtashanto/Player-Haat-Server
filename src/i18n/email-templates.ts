import type { MailMessage } from "../lib/mailer.js";

export type EmailKind = "verify" | "reset";
export type EmailLocale = "bn" | "en";

interface Copy {
  subject: string;
  greeting: (name: string) => string;
  intro: string;
  expires: (minutes: number) => string;
  ignore: string;
}

const copy: Record<EmailKind, Record<EmailLocale, Copy>> = {
  verify: {
    en: {
      subject: "Verify your PlayerHaat email",
      greeting: (n) => `Hi ${n},`,
      intro: "Use this code to verify your email address:",
      expires: (m) => `The code expires in ${m} minutes.`,
      ignore: "If you didn't create a PlayerHaat account, you can ignore this email.",
    },
    bn: {
      subject: "আপনার PlayerHaat ইমেইল যাচাই করুন",
      greeting: (n) => `হ্যালো ${n},`,
      intro: "আপনার ইমেইল ঠিকানা যাচাই করতে এই কোডটি ব্যবহার করুন:",
      expires: (m) => `কোডটি ${m} মিনিট পর্যন্ত বৈধ।`,
      ignore: "আপনি PlayerHaat অ্যাকাউন্ট না খুলে থাকলে এই ইমেইলটি উপেক্ষা করুন।",
    },
  },
  reset: {
    en: {
      subject: "Reset your PlayerHaat password",
      greeting: (n) => `Hi ${n},`,
      intro: "Use this code to reset your password:",
      expires: (m) => `The code expires in ${m} minutes.`,
      ignore: "If you didn't ask to reset your password, you can ignore this email — your password is unchanged.",
    },
    bn: {
      subject: "আপনার PlayerHaat পাসওয়ার্ড রিসেট করুন",
      greeting: (n) => `হ্যালো ${n},`,
      intro: "আপনার পাসওয়ার্ড রিসেট করতে এই কোডটি ব্যবহার করুন:",
      expires: (m) => `কোডটি ${m} মিনিট পর্যন্ত বৈধ।`,
      ignore: "আপনি পাসওয়ার্ড রিসেটের অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন — আপনার পাসওয়ার্ড অপরিবর্তিত আছে।",
    },
  },
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderCodeEmail(
  kind: EmailKind,
  locale: EmailLocale,
  p: { to: string; name: string; code: string; expiresMinutes: number },
): MailMessage {
  const c = copy[kind][locale];
  const text = [c.greeting(p.name), "", c.intro, "", p.code, "", c.expires(p.expiresMinutes), c.ignore].join("\n");
  const html = `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px">
<p>${escapeHtml(c.greeting(p.name))}</p>
<p>${escapeHtml(c.intro)}</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:24px 0">${escapeHtml(p.code)}</p>
<p style="color:#555">${escapeHtml(c.expires(p.expiresMinutes))}</p>
<p style="color:#888;font-size:13px">${escapeHtml(c.ignore)}</p>
</body></html>`;
  return { to: p.to, subject: c.subject, html, text };
}
