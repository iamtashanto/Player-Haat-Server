import type { NotificationType, Prisma } from "@prisma/client";
import { paramsToData, renderPush, type Locale, type PushParams } from "../../i18n/push-templates.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { push } from "../../lib/push/index.js";

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
}

/**
 * Fire-and-forget: writes an inbox row per recipient, then pushes to their devices, in their language.
 * Inbox rows are written even for users with no device, so nothing is lost if push is off.
 */
export function notify(input: NotifyInput) {
  if (input.userIds.length === 0) return;
  runInBackground(`notify:${input.type}`, () => deliver(input));
}

type Recipient = { id: string; locale: Locale; deviceTokens: { token: string }[] };

const loadRecipients = (userIds: string[]): Promise<Recipient[]> =>
  prisma.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, status: "ACTIVE" },
    select: { id: true, locale: true, deviceTokens: { select: { token: true } } },
  });

/** Push only (no inbox row) — for callers that write the inbox rows themselves, e.g. the reminder job. */
export async function pushOnly(userIds: string[], type: NotificationType, data: Record<string, string>, params: PushParams) {
  await pushToRecipients(await loadRecipients(userIds), type, { ...data, ...paramsToData(params) }, params);
}

async function pushToRecipients(users: Recipient[], type: NotificationType, payload: Record<string, string>, params: PushParams) {
  // One FCM call per language (the copy differs), not per user.
  const tokensByLocale = new Map<Locale, string[]>();
  for (const u of users) {
    const list = tokensByLocale.get(u.locale) ?? [];
    list.push(...u.deviceTokens.map((d) => d.token));
    tokensByLocale.set(u.locale, list);
  }

  for (const [locale, tokens] of tokensByLocale) {
    if (tokens.length === 0) continue;
    const { title, body } = renderPush(type, params, locale);
    try {
      const { invalidTokens } = await push.send(tokens, { title, body, data: { type, ...payload } });
      if (invalidTokens.length) await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
    } catch (err) {
      logger.error({ err, type, locale }, "push send failed"); // the inbox row already exists
    }
  }
}

async function deliver({ userIds, type, data, params }: NotifyInput) {
  const users = await loadRecipients(userIds);
  if (users.length === 0) return;

  const payload = { ...data, ...paramsToData(params) };
  await prisma.notification.createMany({
    data: users.map((u) => ({ userId: u.id, type, data: payload as Prisma.InputJsonObject })),
  });
  await pushToRecipients(users, type, payload, params);
}
