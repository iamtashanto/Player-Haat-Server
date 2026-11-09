import type { NotificationPreference } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { categoryOf, isChat } from "./categories.js";
import type { NotificationType } from "@prisma/client";

export const DEFAULT_PREFS = {
  games: true,
  messages: true,
  recruitment: true,
  system: true,
  nearbyAvailable: true,
  quietHoursEnabled: true,
  quietStart: "23:00",
  quietEnd: "07:00",
  chatInQuietHours: false,
} as const;

export type Prefs = Omit<NotificationPreference, "userId" | "updatedAt">;

export async function getPrefs(userId: string): Promise<Prefs> {
  const row = await prisma.notificationPreference.findUnique({ where: { userId } });
  return row ?? { ...DEFAULT_PREFS };
}

export async function setPrefs(userId: string, input: Partial<Prefs>): Promise<Prefs> {
  const row = await prisma.notificationPreference.upsert({ where: { userId }, create: { userId, ...input }, update: input });
  return row;
}

const DAY = 86_400_000;
const OFFSET = 6 * 3_600_000; // Asia/Dhaka, no DST
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes since midnight on the Dhaka clock. */
export const dhakaMinutes = (now: Date) => Math.floor((((now.getTime() + OFFSET) % DAY) + DAY) % DAY / 60_000);

export function inQuietHours(now: Date, p: Pick<Prefs, "quietHoursEnabled" | "quietStart" | "quietEnd">): boolean {
  if (!p.quietHoursEnabled) return false;
  const s = minutes(p.quietStart);
  const e = minutes(p.quietEnd);
  if (s === e) return false;
  const n = dhakaMinutes(now);
  return s < e ? n >= s && n < e : n >= s || n < e; // 23:00–07:00 wraps past midnight
}

/** The next instant the quiet window ends. */
export function quietEnds(now: Date, p: Pick<Prefs, "quietEnd">): Date {
  const e = minutes(p.quietEnd);
  const delta = (e - dhakaMinutes(now) + 1440) % 1440 || 1440;
  const base = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(base + delta * 60_000);
}

export type Decision = { kind: "send" } | { kind: "defer"; until: Date } | { kind: "skip"; reason: string };

/** Whether (and when) a push of this type should go to a user with these preferences. The inbox row is written regardless. */
export function decide(type: NotificationType, p: Prefs, now: Date): Decision {
  if (!p[categoryOf(type)]) return { kind: "skip", reason: "CATEGORY_OFF" };
  if (type === "NEARBY_AVAILABLE" && !p.nearbyAvailable) return { kind: "skip", reason: "CATEGORY_OFF" };
  if (inQuietHours(now, p) && !(isChat(type) && p.chatInQuietHours)) return { kind: "defer", until: quietEnds(now, p) };
  return { kind: "send" };
}
