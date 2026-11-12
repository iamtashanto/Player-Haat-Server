import type { NotificationType } from "@prisma/client";

/** The four groups a user can switch on or off — and the Android channels the app creates. */
export type Category = "games" | "messages" | "recruitment" | "system";

const BY_TYPE: Record<NotificationType, Category> = {
  NEW_MATCHING_REQUEST: "games",
  NEW_APPLICANT: "games",
  APPLICATION_ACCEPTED: "games",
  APPLICATION_REJECTED: "games",
  APPLICATION_WITHDRAWN: "games",
  REQUEST_CANCELLED: "games",
  REQUEST_UPDATED: "games",
  REQUEST_FILLED: "games",
  WAITLIST_PROMOTED: "games",
  GAME_REMINDER: "games",
  RATING_REMINDER: "games",
  NEARBY_AVAILABLE: "games",
  NEW_MESSAGE: "messages",
  GAME_MESSAGE: "messages",
  INVITE_RECEIVED: "recruitment",
  INVITE_ACCEPTED: "recruitment",
  INVITE_DECLINED: "recruitment",
  CONTACT_VIEWED: "recruitment",
  PROFILE_VIEWED: "recruitment",
  VERIFICATION_RESULT: "system",
  TEAM_JOINED: "system",
  SYSTEM: "system",
  ANNOUNCEMENT: "system",
};

export const categoryOf = (type: NotificationType): Category => BY_TYPE[type];
export const isChat = (type: NotificationType) => type === "NEW_MESSAGE" || type === "GAME_MESSAGE";

/**
 * Where a notification opens, as an in-app path. Sent with the push (FCM data `link`) so a tap lands on the right
 * screen in the app and on the web; the inbox uses the same rule.
 */
export function linkFor(type: NotificationType, d: Record<string, unknown>): string {
  const s = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : undefined);
  switch (type) {
    case "NEW_MESSAGE":
      return s("conversationId") ? `/chat/${s("conversationId")}` : "/messages";
    case "GAME_MESSAGE":
      return s("gameId") ? `/games/${s("gameId")}/chat` : "/messages";
    case "RATING_REMINDER":
      return s("requestId") ? `/rate/${s("requestId")}` : "/games";
    case "INVITE_RECEIVED":
    case "INVITE_ACCEPTED":
    case "INVITE_DECLINED":
      return "/invites";
    case "CONTACT_VIEWED":
    case "PROFILE_VIEWED":
      return "/me/viewers";
    case "NEARBY_AVAILABLE":
      return "/players?availableToday=true";
    case "TEAM_JOINED":
      return s("teamId") ? `/team/${s("teamId")}` : "/teams";
    case "VERIFICATION_RESULT":
    case "SYSTEM":
    case "ANNOUNCEMENT":
      return "/alerts";
    default:
      return s("requestId") ? `/request/${s("requestId")}` : "/alerts";
  }
}
