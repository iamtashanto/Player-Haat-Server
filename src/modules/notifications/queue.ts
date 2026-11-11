import { Prisma, type NotificationType } from "@prisma/client";
import { paramsFromData, renderPush } from "../../i18n/push-templates.js";
import { clock } from "../../lib/clock.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { push } from "../../lib/push/index.js";
import { webPush } from "../../lib/webpush/index.js";
import { categoryOf, linkFor } from "./categories.js";

/**
 * The push queue. Request handlers only INSERT into PushJob; this file sends. A failed send is retried with
 * exponential backoff (30 s, 2 min, 8 min, 32 min) and then marked FAILED. The same rows are the send log the
 * dashboard reads. Several API instances can run it at once: jobs are claimed with FOR UPDATE SKIP LOCKED.
 */
export const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 5 * 60_000;
export const backoffMs = (attempt: number) => Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 2 * 3_600_000);

export interface NewJob {
  userId: string;
  type: NotificationType;
  payload: Record<string, string>;
  /** Not before this instant (quiet hours end, …). */
  at?: Date;
  expiresAt?: Date;
  collapseKey?: string;
  announcementId?: string;
  /** Logged as SKIPPED with this reason instead of being sent. */
  skipReason?: string;
}

/** Inserts jobs; a job with a collapseKey folds into a still-pending one (its payload `count` goes up). Returns ids to send now. */
export async function enqueue(jobs: NewJob[]): Promise<string[]> {
  const ids: string[] = [];
  for (const j of jobs) {
    const skipped = j.skipReason !== undefined;
    if (j.collapseKey && !skipped) {
      const folded = await prisma.$queryRaw<{ id: string }[]>`
        UPDATE "PushJob"
        SET payload = payload || ${JSON.stringify(j.payload)}::jsonb || jsonb_build_object('count', (COALESCE((payload->>'count')::int, 1) + 1)::text)
        WHERE "userId" = ${j.userId} AND "collapseKey" = ${j.collapseKey} AND status = 'PENDING'
        RETURNING id`;
      if (folded.length > 0) continue; // the earlier push will carry it
    }
    try {
      const row = await prisma.pushJob.create({
        data: {
          userId: j.userId,
          type: j.type,
          payload: j.payload as Prisma.InputJsonObject,
          status: skipped ? "SKIPPED" : "PENDING",
          nextAttemptAt: j.at ?? clock.now(),
          expiresAt: j.expiresAt ?? null,
          collapseKey: skipped ? null : (j.collapseKey ?? null),
          announcementId: j.announcementId ?? null,
          skipReason: j.skipReason ?? null,
        },
        select: { id: true, nextAttemptAt: true },
      });
      if (!skipped && row.nextAttemptAt.getTime() <= clock.now().getTime()) ids.push(row.id);
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err; // lost a race on the collapse key: the other job carries it
    }
  }
  return ids;
}

async function claim(now: Date, limit: number, only?: string[]): Promise<string[]> {
  const nowIso = now.toISOString();
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "PushJob" SET status = 'SENDING', attempts = attempts + 1, "nextAttemptAt" = ${lease}::timestamp
    WHERE id IN (
      SELECT id FROM "PushJob"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${nowIso}::timestamp ${only ? Prisma.sql`AND id IN (${Prisma.join(only)})` : Prisma.empty}
      ORDER BY "nextAttemptAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((r) => r.id);
}

async function sendOne(id: string, now: Date) {
  const job = await prisma.pushJob.findUnique({ where: { id }, include: { user: { select: { status: true, locale: true, deviceTokens: { where: { platform: { not: "WEB" } }, select: { token: true } }, webPushSubscriptions: { select: { id: true, endpoint: true, p256dh: true, auth: true } } } } } });
  if (!job || job.status !== "SENDING") return;
  const done = (data: Prisma.PushJobUpdateInput) => prisma.pushJob.update({ where: { id }, data });

  if (job.expiresAt && job.expiresAt.getTime() <= now.getTime()) return void (await done({ status: "SKIPPED", skipReason: "EXPIRED" }));
  const tokens = job.user.deviceTokens.map((d) => d.token);
  const subs = webPush.enabled ? job.user.webPushSubscriptions : [];
  const fcm = push.enabled ? tokens : [];
  const devices = tokens.length + job.user.webPushSubscriptions.length;
  if (job.user.status !== "ACTIVE" || devices === 0) return void (await done({ status: "SKIPPED", skipReason: "NO_DEVICE" }));
  if (fcm.length + subs.length === 0) return void (await done({ status: "SKIPPED", skipReason: "PUSH_NOT_CONFIGURED", deviceCount: devices }));

  const payload = (job.payload ?? {}) as Record<string, string>;
  const { title, body } = renderPush(job.type, paramsFromData(payload), job.user.locale);
  const link = linkFor(job.type, payload);
  let delivered = 0;
  let error: string | undefined;
  if (fcm.length > 0) {
    try {
      const { invalidTokens } = await push.send(fcm, { title, body, data: { type: job.type, link, ...payload }, channel: categoryOf(job.type) });
      if (invalidTokens.length) await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
      delivered += fcm.length - invalidTokens.length;
    } catch (err) {
      error = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
  }
  const gone: string[] = [];
  for (const sub of subs) {
    try {
      if ((await webPush.send(sub, { title, body, link: `/${job.user.locale}${link}`, data: { type: job.type, ...payload } })) === "gone") gone.push(sub.id);
      else delivered++;
    } catch (err) {
      error = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
  }
  if (gone.length) await prisma.webPushSubscription.deleteMany({ where: { id: { in: gone } } });

  // Something got through: done (retrying would notify that device twice). Nothing did and something failed: retry.
  if (delivered > 0 || !error) return void (await done({ status: "SENT", sentAt: new Date(), deviceCount: devices, deliveredCount: delivered, lastError: error ?? null }));
  if (job.attempts >= MAX_ATTEMPTS) {
    logger.warn({ jobId: id, type: job.type }, "push gave up after retries");
    return void (await done({ status: "FAILED", lastError: error, deviceCount: devices }));
  }
  await done({ status: "PENDING", lastError: error, nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)) });
}

/** Sends what is due (all of it, or only `only`). Returns how many jobs were attempted. */
export async function processDue(now = clock.now(), opts: { limit?: number; only?: string[] } = {}): Promise<number> {
  if (opts.only && opts.only.length === 0) return 0;
  const ids = await claim(now, opts.limit ?? 100, opts.only);
  for (const id of ids) {
    try {
      await sendOne(id, now);
    } catch (err) {
      logger.error({ err, jobId: id }, "push job crashed"); // stays SENDING; the lease sweep puts it back
    }
  }
  return ids.length;
}

/** Jobs a crashed worker left in SENDING go back in the queue once their lease has run out. */
export async function releaseStuck(now = clock.now()): Promise<number> {
  const { count } = await prisma.pushJob.updateMany({ where: { status: "SENDING", nextAttemptAt: { lt: now } }, data: { status: "PENDING" } });
  return count;
}

/** The scheduled job: put stuck work back, then send what is due. */
export async function runQueue(now = clock.now()) {
  const released = await releaseStuck(now);
  const attempted = await processDue(now);
  return released || attempted ? { released, attempted } : null;
}
