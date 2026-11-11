import type { NotificationType, Prisma } from "@prisma/client";
import { paramsToData, type PushParams } from "../../i18n/push-templates.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { clock } from "../../lib/clock.js";
import { DEFAULT_PREFS, decide, type Prefs } from "./preferences.js";
import { enqueue, processDue, type NewJob } from "./queue.js";

// ── background execution ──
// Notifications must never slow down or fail the request that triggered them, so they run after the
// response is decided. We keep the promises so tests and graceful shutdown can wait for them.
const pending = new Set<Promise<unknown>>();

export function runInBackground(label: string, fn: () => Promise<unknown>) {
  const p: Promise<unknown> = fn()
    .catch((err) => logger.error({ err, label }, "background task failed"))
    .finally(() => pending.delete(p));
  pending.add(p);
}

export async function flushBackground() {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export interface NotifyInput {
  userIds: string[];
  type: NotificationType;
  /** Deep-link payload stored on the inbox row and sent as the FCM data payload (strings only). */
  data: Record<string, string>;
  params: PushParams;
  /** Several notifications with the same key fold into one still-unsent push (a burst of chat messages). */
  collapseKey?: string;
  announcementId?: string;
  /** Drop the push if it would only go out after this instant (a reminder that would arrive after the game). */
  expiresAt?: Date;
  /** false = queue the push only (the caller already wrote the inbox rows). */
  inbox?: boolean;
}

/**
 * Fire-and-forget: writes an inbox row per recipient, then queues a push per recipient (see queue.ts).
 * Inbox rows are written whatever the user's push settings are, so nothing is lost if push is off. The push
 * honours their preferences: a switched-off category is logged and skipped; quiet hours hold it until they end.
 */
export function notify(input: NotifyInput) {
  if (input.userIds.length === 0) return;
  runInBackground(`notify:${input.type}`, () => deliver(input));
}

type Recipient = { id: string; devices: number };

const loadRecipients = (userIds: string[]): Promise<Array<Recipient & { prefs: Prefs }>> =>
  prisma.user
    .findMany({
      where: { id: { in: [...new Set(userIds)] }, status: "ACTIVE" },
      select: { id: true, notificationPreference: true, _count: { select: { deviceTokens: { where: { platform: { not: "WEB" } } }, webPushSubscriptions: true } } },
    })
    .then((rows) => rows.map((u) => ({ id: u.id, devices: u._count.deviceTokens + u._count.webPushSubscriptions, prefs: u.notificationPreference ?? { ...DEFAULT_PREFS } })));

/** Push only (no inbox row) — for callers that write the inbox rows themselves, e.g. the reminder job. */
export async function pushOnly(userIds: string[], type: NotificationType, data: Record<string, string>, params: PushParams, extra: { expiresAt?: Date; collapseKey?: string } = {}) {
  await dispatch(await loadRecipients(userIds), { userIds, type, data, params, inbox: false, ...extra });
}

async function dispatch(users: Array<Recipient & { prefs: Prefs }>, input: NotifyInput) {
  const now = clock.now();
  const payload = { ...input.data, ...paramsToData(input.params) };
  const jobs: NewJob[] = [];
  for (const u of users) {
    const d = decide(input.type, u.prefs, now);
    // Users with no device and no stake in the log get no row at all; announcements log every recipient so the stats add up.
    if (d.kind === "skip") jobs.push({ userId: u.id, type: input.type, payload, announcementId: input.announcementId, skipReason: d.reason });
    else if (u.devices === 0) {
      if (input.announcementId) jobs.push({ userId: u.id, type: input.type, payload, announcementId: input.announcementId, skipReason: "NO_DEVICE" });
    } else {
      jobs.push({
        userId: u.id,
        type: input.type,
        payload,
        at: d.kind === "defer" ? d.until : undefined,
        expiresAt: input.expiresAt,
        collapseKey: input.collapseKey,
        announcementId: input.announcementId,
      });
    }
  }
  if (jobs.length === 0) return;
  try {
    const sendNow = await enqueue(jobs);
    await processDue(now, { only: sendNow });
  } catch (err) {
    logger.error({ err, type: input.type }, "queueing push failed"); // the inbox row already exists
  }
}

async function deliver(input: NotifyInput) {
  const users = await loadRecipients(input.userIds);
  if (users.length === 0) return;
  if (input.inbox !== false) {
    const payload = { ...input.data, ...paramsToData(input.params) };
    await prisma.notification.createMany({
      data: users.map((u) => ({ userId: u.id, type: input.type, data: payload as Prisma.InputJsonObject })),
    });
  }
  await dispatch(users, input);
}
