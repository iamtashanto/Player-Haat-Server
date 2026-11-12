import type { NotificationType } from "@prisma/client";

export type Locale = "bn" | "en";

export interface PushParams {
  /** Localized sport name. */
  sport?: { bn: string; en: string };
  venue?: string;
  /** Match time; rendered in Asia/Dhaka. */
  when?: Date;
  /** Display name of the other party (applicant / captain / sender). */
  actor?: string;
  /** A short piece of user text, e.g. the start of a chat message. */
  text?: string;
  /** A custom heading (admin announcements). */
  heading?: string;
  /** "2h" before the game or "morning" of the day (GAME_REMINDER). */
  when2?: "2h" | "morning";
  /** How many messages a collapsed chat push stands for. */
  count?: number;
  /** Which outcome a SYSTEM notification reports; the copy lives here so it can be localized. */
  code?: "PAYMENT_APPROVED" | "PAYMENT_REJECTED" | "VERIFICATION_APPROVED" | "VERIFICATION_REJECTED" | "REVIEW_REVEALED" | "DISPUTE_UPHELD" | "DISPUTE_REMOVED" | "DISPUTE_OPENED" | "PENDING" | "ACCEPTED" | "RESULT_CONFIRMED" | "RESULT_REJECTED" | "CHALLENGE_ACCEPTED" | "TOURNAMENT_STARTED";
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
  INVITE_RECEIVED: (p, l) => ({
    title: l === "bn" ? "আপনাকে আমন্ত্রণ জানানো হয়েছে" : "You've been invited",
    body: [p.actor, line(p, l)].filter(Boolean).join(" · "),
  }),
  INVITE_ACCEPTED: (p, l) => ({
    title: l === "bn" ? "আমন্ত্রণ গৃহীত হয়েছে 🎉" : "Invitation accepted 🎉",
    body: p.actor ?? "",
  }),
  INVITE_DECLINED: (p, l) => ({
    title: l === "bn" ? "আমন্ত্রণ গৃহীত হয়নি" : "Invitation declined",
    body: p.actor ?? "",
  }),
  CONTACT_VIEWED: (p, l) => ({
    title: l === "bn" ? "কেউ আপনার নম্বর দেখেছেন" : "Someone viewed your number",
    body: p.actor ?? "",
  }),
  PROFILE_VIEWED: (p, l) => ({
    title: l === "bn" ? "একজন রিক্রুটার আপনার প্রোফাইল দেখেছেন" : "A recruiter viewed your profile",
    body: p.actor ?? "",
  }),
  NEW_MESSAGE: (p, l) => ({ title: p.actor ?? (l === "bn" ? "নতুন বার্তা" : "New message"), body: p.text ?? "" }),
  VERIFICATION_RESULT: (p, l) => ({
    title: l === "bn" ? "ভেরিফিকেশন আপডেট" : "Verification update",
    body:
      p.code === "VERIFICATION_APPROVED"
        ? l === "bn" ? "আপনার ভেরিফিকেশন অনুমোদিত হয়েছে ✓" : "Your verification was approved ✓"
        : l === "bn" ? "আপনার ভেরিফিকেশন অনুমোদিত হয়নি" : "Your verification wasn't approved",
  }),
  TEAM_JOINED: (p, l) => ({
    title: l === "bn" ? "দলে নতুন সদস্য" : "New team member",
    body: p.actor ?? "",
  }),
  NEARBY_AVAILABLE: (p, l) => ({
    title: l === "bn" ? "আপনার কাছে কেউ আজ খেলতে পারবে" : "Someone near you is free to play today",
    body: [p.sport?.[l], p.venue].filter(Boolean).join(" · "),
  }),
  GAME_REMINDER: (p, l) => ({
    title:
      p.when2 === "morning"
        ? l === "bn" ? "আজ আপনার ম্যাচ আছে" : "You have a match today"
        : l === "bn" ? "ম্যাচ শুরু হবে ২ ঘণ্টা পরে" : "Match starts in 2 hours",
    body: line(p, l),
  }),
  REQUEST_FILLED: (p, l) => ({
    title: l === "bn" ? "ম্যাচে আর জায়গা নেই" : "The match is full",
    body: line(p, l),
  }),
  RESULT_CONFIRM_ASKED: (p, l) => ({
    title: l === "bn" ? "স্কোর নিশ্চিত করুন" : "Please confirm the score",
    body: [p.actor, p.text].filter(Boolean).join(" · "),
  }),
  RAIN_ALERT: (p, l) => ({
    title: l === "bn" ? "ম্যাচের সময় বৃষ্টির সম্ভাবনা" : "Rain is likely at match time",
    body: [p.text ? (l === "bn" ? `বৃষ্টির সম্ভাবনা ${p.text}` : `${p.text} chance of rain`) : "", line(p, l)].filter(Boolean).join(" · "),
  }),
  RESULT_POSTED: (p, l) => ({
    title: l === "bn" ? "ম্যাচের ফল তোলা হয়েছে" : "Match result is in",
    body: [p.text, line(p, l)].filter(Boolean).join(" · "),
  }),
  SERIES_GAME_POSTED: (p, l) => ({
    title: p.heading ?? (l === "bn" ? "এই সপ্তাহের খেলা" : "This week's game"),
    body: line(p, l),
  }),
  WAITLIST_PROMOTED: (p, l) => ({
    title:
      p.code === "PENDING"
        ? l === "bn" ? "একটি জায়গা খালি হয়েছে" : "A spot opened up"
        : l === "bn" ? "আপনি ম্যাচে আছেন!" : "You're in!",
    body: line(p, l),
  }),
  GAME_MESSAGE: (p, l) => ({
    title: p.venue ? `${p.sport?.[l] ?? ""} · ${p.venue}`.trim().replace(/^·\s*/, "") : l === "bn" ? "গেম চ্যাট" : "Game chat",
    body: (p.count ?? 1) > 1 ? (l === "bn" ? `${p.count}টি নতুন বার্তা` : `${p.count} new messages`) : `${p.actor ?? ""}: ${p.text ?? ""}`.replace(/^: /, ""),
  }),
  ANNOUNCEMENT: (p) => ({ title: p.heading ?? "PlayerHaat", body: p.text ?? "" }),
  SYSTEM: (p, l) => ({
    title: "PlayerHaat",
    body:
      p.code === "REVIEW_REVEALED"
        ? l === "bn" ? "নতুন রিভিউ এসেছে" : "You have a new review"
        : p.code === "DISPUTE_UPHELD"
          ? l === "bn" ? "আপত্তি পর্যালোচনা শেষ: রিভিউ/স্ট্রাইক বহাল থাকছে" : "Dispute reviewed: the review/strike stays"
          : p.code === "DISPUTE_REMOVED"
            ? l === "bn" ? "আপত্তি গৃহীত হয়েছে: রিভিউ/স্ট্রাইক সরানো হয়েছে" : "Dispute accepted: the review/strike was removed"
            : p.code === "DISPUTE_OPENED"
              ? l === "bn" ? "আপনার দেওয়া রিভিউ/স্ট্রাইকে আপত্তি এসেছে, পর্যালোচনা চলছে" : "A review/strike you gave was disputed and is under review"
      : p.code === "RESULT_CONFIRMED"
        ? l === "bn" ? "প্রতিপক্ষ দল স্কোর নিশ্চিত করেছে, এটি পয়েন্ট টেবিলে গোনা হবে" : "The other team confirmed the score; it counts in the standings"
        : p.code === "RESULT_REJECTED"
          ? l === "bn" ? "প্রতিপক্ষ দল স্কোর মানেনি, এটি পয়েন্ট টেবিলে গোনা হবে না" : "The other team rejected the score; it won't count in the standings"
          : p.code === "TOURNAMENT_STARTED"
            ? l === "bn" ? `টুর্নামেন্ট শুরু হয়েছে: ${p.heading ?? ""}`.trim() : `The tournament has started: ${p.heading ?? ""}`.trim()
          : p.code === "CHALLENGE_ACCEPTED"
            ? l === "bn" ? "আপনার চ্যালেঞ্জ গৃহীত হয়েছে, ম্যাচ তৈরি হয়েছে" : "Your challenge was accepted and the match is set"
      : p.code === "PAYMENT_APPROVED"
        ? l === "bn" ? "আপনার পেমেন্ট নিশ্চিত হয়েছে, ক্রেডিট যোগ হয়েছে ✓" : "Payment confirmed — credits added ✓"
        : p.code === "PAYMENT_REJECTED"
          ? l === "bn" ? "আপনার পেমেন্ট যাচাই করা যায়নি" : "We couldn't verify your payment"
          : l === "bn" ? "নতুন বার্তা" : "New message",
  }),
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
    ...(p.text && { text: p.text }),
    ...(p.heading && { heading: p.heading }),
    ...(p.when2 && { when2: p.when2 }),
    ...(p.count !== undefined && { count: String(p.count) }),
    ...(p.code && { code: p.code }),
  };
}

export function paramsFromData(d: Record<string, unknown>): PushParams {
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  return {
    sport: str("sportBn") && str("sportEn") ? { bn: str("sportBn")!, en: str("sportEn")! } : undefined,
    venue: str("venue"),
    when: str("matchAt") ? new Date(str("matchAt")!) : undefined,
    actor: str("actor"),
    text: str("text"),
    heading: str("heading"),
    when2: str("when2") as PushParams["when2"],
    count: str("count") ? Number(str("count")) : undefined,
    code: str("code") as PushParams["code"],
  };
}
