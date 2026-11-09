import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { paramsToData, type PushParams } from "../../i18n/push-templates.js";
import { clock } from "../../lib/clock.js";
import { endOfDhakaDay } from "../../lib/dhaka-time.js";
import { prisma } from "../../lib/prisma.js";
import { notify, pushOnly } from "./notifier.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** At most this many "someone near you is free today" a person gets per Dhaka day. */
export const NEARBY_PER_DAY = 2;
/** A player who keeps toggling "free today" tells their neighbours at most once in this long. */
export const NEARBY_DEBOUNCE_MS = 6 * HOUR;
const NEARBY_MAX_RECIPIENTS = 100;

const startOfDhakaDay = (now: Date) => new Date(endOfDhakaDay(now).getTime() - DAY);

/**
 * "Someone near you is free to play today." Goes to players in the same upazila who play one of those sports and to
 * anyone with an open game for the sport in the same district — never the person themselves, never their name
 * (the opaque `src` only lets us debounce). Debounced per player and capped per recipient per day.
 */
export async function notifyNearbyAvailable(profileId: string, sportIds: number[]) {
  const now = clock.now();
  const me = await prisma.playerProfile.findUnique({
    where: { id: profileId },
    select: { userId: true, districtId: true, upazilaId: true, upazila: { select: { nameBn: true, nameEn: true } } },
  });
  if (!me || sportIds.length === 0) return 0;
  const src = createHash("sha256").update(profileId).digest("hex").slice(0, 12);

  const recent = await prisma.notification.count({
    where: { type: "NEARBY_AVAILABLE", createdAt: { gte: new Date(now.getTime() - NEARBY_DEBOUNCE_MS) }, data: { path: ["src"], equals: src } },
  });
  if (recent > 0) return 0;

  const [neighbours, organisers, sports] = await Promise.all([
    prisma.user.findMany({
      where: { status: "ACTIVE", id: { not: me.userId }, playerProfile: { is: { upazilaId: me.upazilaId, isVisible: true, hiddenByAdminAt: null, sports: { some: { sportId: { in: sportIds } } } } } },
      select: { id: true },
      take: NEARBY_MAX_RECIPIENTS,
    }),
    prisma.user.findMany({
      where: { status: "ACTIVE", id: { not: me.userId }, requestsCreated: { some: { kind: "MATCH", status: "OPEN", isHidden: false, matchAt: { gt: now }, districtId: me.districtId, sportId: { in: sportIds } } } },
      select: { id: true },
      take: NEARBY_MAX_RECIPIENTS,
    }),
    prisma.sport.findMany({ where: { id: { in: sportIds } }, select: { nameBn: true, nameEn: true }, orderBy: { id: "asc" }, take: 1 }),
  ]);
  const candidates = [...new Set([...neighbours, ...organisers].map((u) => u.id))].slice(0, NEARBY_MAX_RECIPIENTS);
  if (candidates.length === 0) return 0;

  const today = await prisma.notification.groupBy({
    by: ["userId"],
    where: { type: "NEARBY_AVAILABLE", userId: { in: candidates }, createdAt: { gte: startOfDhakaDay(now) } },
    _count: { _all: true },
  });
  const full = new Set(today.filter((t) => t._count._all >= NEARBY_PER_DAY).map((t) => t.userId));
  const recipients = candidates.filter((id) => !full.has(id));
  if (recipients.length === 0) return 0;

  const sport = sports[0];
  notify({
    userIds: recipients,
    type: "NEARBY_AVAILABLE",
    data: { src, sportId: String(sportIds[0]), upazilaId: String(me.upazilaId) },
    params: { ...(sport && { sport: { bn: sport.nameBn, en: sport.nameEn } }), venue: me.upazila.nameEn },
  });
  return recipients.length;
}

/** The game you applied to just filled up: tell the people still waiting, so they can look elsewhere. */
export async function notifyFilled(requestId: string) {
  const r = await prisma.playerRequest.findUnique({
    where: { id: requestId },
    select: { venueText: true, matchAt: true, sport: { select: { nameBn: true, nameEn: true } }, applications: { where: { status: "PENDING" }, select: { playerId: true } } },
  });
  if (!r || r.applications.length === 0) return;
  notify({
    userIds: r.applications.map((a) => a.playerId),
    type: "REQUEST_FILLED",
    data: { requestId },
    params: { sport: { bn: r.sport.nameBn, en: r.sport.nameEn }, venue: r.venueText, when: r.matchAt },
  });
}

/**
 * Game reminders for the organiser and accepted players: "2 hours to go" and "you have a match today" (the morning
 * of, 07:00–10:00 Dhaka). Each person gets each reminder once per game — the inbox row carries the marker — and
 * one instance runs at a time (advisory lock). A reminder that would arrive after kick-off is dropped.
 */
export async function sendGameReminders(now = clock.now()): Promise<number> {
  const horizon = new Date(now.getTime() + 2 * HOUR);
  const dayEnd = endOfDhakaDay(now);
  const dhakaHour = new Date(now.getTime() + 6 * HOUR).getUTCHours();
  const morning = dhakaHour >= 7 && dhakaHour < 10;

  const sent = await prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('game-reminders')) AS locked`;
      if (!lock[0]?.locked) return null;

      const games = await tx.playerRequest.findMany({
        where: {
          kind: "MATCH",
          isHidden: false,
          status: { in: ["OPEN", "FILLED"] },
          matchAt: { gt: now, lte: morning ? dayEnd : horizon },
        },
        select: {
          id: true, venueText: true, matchAt: true, createdById: true,
          sport: { select: { nameBn: true, nameEn: true } },
          applications: { where: { status: "ACCEPTED" }, select: { playerId: true } },
        },
        take: 500,
      });

      const rows: Array<{ userId: string; requestId: string; kind: "2h" | "morning"; params: PushParams; matchAt: Date }> = [];
      for (const g of games) {
        const kind: "2h" | "morning" = g.matchAt.getTime() <= horizon.getTime() ? "2h" : "morning";
        const params: PushParams = { sport: { bn: g.sport.nameBn, en: g.sport.nameEn }, venue: g.venueText, when: g.matchAt, when2: kind };
        for (const userId of new Set([g.createdById, ...g.applications.map((a) => a.playerId)])) rows.push({ userId, requestId: g.id, kind, params, matchAt: g.matchAt });
      }
      if (rows.length === 0) return [];

      const seen = await tx.notification.findMany({
        where: { type: "GAME_REMINDER", userId: { in: [...new Set(rows.map((r) => r.userId))] }, createdAt: { gte: new Date(now.getTime() - 2 * DAY) } },
        select: { userId: true, data: true },
      });
      const done = new Set(seen.map((n) => `${n.userId}|${(n.data as Record<string, unknown>).dedupe}`));
      const fresh = rows.filter((r) => !done.has(`${r.userId}|${r.requestId}:${r.kind}`));
      if (fresh.length === 0) return [];

      await tx.notification.createMany({
        data: fresh.map((r) => ({
          userId: r.userId,
          type: "GAME_REMINDER" as const,
          data: { requestId: r.requestId, dedupe: `${r.requestId}:${r.kind}`, ...paramsToData(r.params) } as Prisma.InputJsonObject,
        })),
      });
      return fresh;
    },
    { timeout: 30_000 },
  );

  if (!sent) return 0;
  for (const r of sent) {
    await pushOnly([r.userId], "GAME_REMINDER", { requestId: r.requestId, dedupe: `${r.requestId}:${r.kind}` }, r.params, { expiresAt: r.matchAt });
  }
  return sent.length;
}
