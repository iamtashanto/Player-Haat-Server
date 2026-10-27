import type { Notification } from "@prisma/client";
import { paramsFromData, renderPush, type Locale } from "../../i18n/push-templates.js";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";

const MAX_DEVICES_PER_USER = 10;

export function toNotification(n: Notification, locale: Locale) {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const { title, body } = renderPush(n.type, paramsFromData(data), locale);
  return { id: n.id, type: n.type, title, body, data, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() };
}

export async function registerDevice(userId: string, input: { token: string; platform: "ANDROID" | "IOS" | "WEB" }) {
  // Token is globally unique: signing in as someone else on the same phone moves it to the new account.
  await prisma.deviceToken.upsert({
    where: { token: input.token },
    update: { userId, platform: input.platform, lastSeenAt: new Date() },
    create: { userId, token: input.token, platform: input.platform },
  });
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true },
  });
  if (devices.length > MAX_DEVICES_PER_USER) {
    await prisma.deviceToken.deleteMany({ where: { id: { in: devices.slice(MAX_DEVICES_PER_USER).map((d) => d.id) } } });
  }
}

export async function unregisterDevice(userId: string, token: string) {
  await prisma.deviceToken.deleteMany({ where: { userId, token } }); // idempotent; can't remove someone else's
}

async function localeOf(userId: string): Promise<Locale> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { locale: true } })).locale;
}

export async function listNotifications(userId: string, q: { cursor?: string; limit: number; unreadOnly?: boolean }) {
  const [locale, rows, unreadCount] = await Promise.all([
    localeOf(userId),
    prisma.notification.findMany({
      where: { userId, ...(q.unreadOnly && { readAt: null }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...cursorArgs(q.cursor, q.limit),
    }),
    unreadCountOf(userId),
  ]);
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map((n) => toNotification(n, locale)), nextCursor, unreadCount };
}

export const unreadCountOf = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });

export async function markRead(userId: string, id: string) {
  const existing = await prisma.notification.findFirst({ where: { id, userId } });
  if (!existing) throw AppError.notFound("NOTIFICATION_NOT_FOUND", "Notification not found");
  const row = existing.readAt ? existing : await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  return toNotification(row, await localeOf(userId));
}

export async function markAllRead(userId: string) {
  const { count } = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: count };
}
