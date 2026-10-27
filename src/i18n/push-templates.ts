import type { NotificationType } from "@prisma/client";

export type Locale = "bn" | "en";

export interface PushParams {
  /** Localized sport name. */
  sport?: { bn: string; en: string };
  venue?: string;
  /** Match time; rendered in Asia/Dhaka. */
  when?: Date;
  /** Display name of the other party (applicant / captain). */
  actor?: string;
}

const fmt = (when: Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(when);

const line = (p: PushParams, locale: Locale) =>
  [p.sport?.[locale], p.venue, p.when && fmt(p.when, locale)].filter(Boolean).join(" · ");

type Template = (p: PushParams, l: Locale) => { title: string; body: string };

/**
 * Push/inbox copy. The app also renders inbox rows from `type` + `data`, so this text is only what
 * shows in the OS notification tray.
 */
const templates: Record<NotificationType, Template> = {
  NEW_MATCHING_REQUEST: (p, l) => ({
    title: l === "bn" ? "আপনার এলাকায় নতুন ম্যাচ" : "New match near you",
    body: line(p, l),
  }),
  NEW_APPLICANT: (p, l) => ({
    title: l === "bn" ? "নতুন আবেদন এসেছে" : "New applicant",
    body: l === "bn" ? `${p.actor} আপনার ম্যাচে খেলতে চান · ${line(p, l)}` : `${p.actor} wants to play · ${line(p, l)}`,
  }),
  APPLICATION_ACCEPTED: (p, l) => ({
    title: l === "bn" ? "আপনার আবেদন গৃহীত হয়েছে 🎉" : "You're in! 🎉",
    body: line(p, l),
  }),
  APPLICATION_REJECTED: (p, l) => ({
    title: l === "bn" ? "আবেদন গৃহীত হয়নি" : "Application not accepted",
    body: line(p, l),
  }),
  APPLICATION_WITHDRAWN: (p, l) => ({
    title: l === "bn" ? "একজন খেলোয়াড় সরে গেছেন" : "A player withdrew",
    body: `${p.actor} · ${line(p, l)}`,
  }),
  REQUEST_CANCELLED: (p, l) => ({
    title: l === "bn" ? "ম্যাচ বাতিল হয়েছে" : "Match cancelled",
    body: line(p, l),
  }),
  REQUEST_UPDATED: (p, l) => ({
    title: l === "bn" ? "ম্যাচের তথ্য বদলেছে" : "Match details changed",
    body: line(p, l),
  }),
  RATING_REMINDER: (p, l) => ({
    title: l === "bn" ? "ম্যাচ কেমন ছিল? রেটিং দিন" : "How was the match? Leave a rating",
    body: line(p, l),
  }),
  SYSTEM: (_p, l) => ({ title: "PlayerHaat", body: l === "bn" ? "নতুন বার্তা" : "New message" }),
};

export const renderPush = (type: NotificationType, params: PushParams, locale: Locale) => templates[type](params, locale);

// The display params travel inside the notification's `data` (as strings) so an inbox row can be
// rendered later, in the reader's language, without re-fetching the request.
export function paramsToData(p: PushParams): Record<string, string> {
  return {
    ...(p.sport && { sportBn: p.sport.bn, sportEn: p.sport.en }),
    ...(p.venue && { venue: p.venue }),
    ...(p.when && { matchAt: p.when.toISOString() }),
    ...(p.actor && { actor: p.actor }),
  };
}

export function paramsFromData(d: Record<string, unknown>): PushParams {
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  return {
    sport: str("sportBn") && str("sportEn") ? { bn: str("sportBn")!, en: str("sportEn")! } : undefined,
    venue: str("venue"),
    when: str("matchAt") ? new Date(str("matchAt")!) : undefined,
    actor: str("actor"),
  };
}
