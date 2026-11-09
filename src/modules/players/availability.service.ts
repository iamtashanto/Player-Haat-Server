import { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { dhakaTimeToday, endOfDhakaDay } from "../../lib/dhaka-time.js";
import { prisma } from "../../lib/prisma.js";
import { runInBackground } from "../notifications/notifier.js";
import { notifyNearbyAvailable } from "../notifications/triggers.js";

export interface AvailabilityInput {
  sportIds: number[];
  /** Optional Dhaka wall-clock window for today, "HH:MM". Defaults: now → midnight. */
  from?: string | undefined;
  until?: string | undefined;
}

const view = (r: { sportId: number; startsAt: Date; endsAt: Date }) => ({
  sportId: r.sportId,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
});

async function profileIdOf(userId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Create your player profile first");
  return p.id;
}

export async function getMyAvailability(userId: string, now = new Date()) {
  const profileId = await profileIdOf(userId);
  const rows = await prisma.playerAvailability.findMany({ where: { profileId, endsAt: { gt: now } }, orderBy: { sportId: "asc" } });
  return { items: rows.map(view) };
}

/** Replaces today's availability: "I'm up for these sports, between these times". */
export async function setMyAvailability(userId: string, input: AvailabilityInput, now = new Date()) {
  const profileId = await profileIdOf(userId);
  const sportIds = [...new Set(input.sportIds)];
  const mine = await prisma.playerSport.findMany({ where: { profileId, sportId: { in: sportIds } }, select: { sportId: true } });
  if (mine.length !== sportIds.length) throw AppError.badRequest("AVAILABILITY_SPORT_NOT_ADDED", "You can only mark yourself available for sports on your profile");

  const midnight = endOfDhakaDay(now);
  const from = input.from ? dhakaTimeToday(now, input.from) : now;
  const until = input.until ? dhakaTimeToday(now, input.until) : midnight;
  if (!from || !until) throw AppError.badRequest("AVAILABILITY_WINDOW_INVALID", "Times must be HH:MM");
  const startsAt = from < now ? now : from;
  if (until <= now || until <= startsAt) throw AppError.badRequest("AVAILABILITY_WINDOW_INVALID", "The window must end in the future, after it starts");

  const wasFree = (await prisma.playerAvailability.count({ where: { profileId, endsAt: { gt: now } } })) > 0;
  await prisma.$transaction([
    prisma.playerAvailability.deleteMany({ where: { profileId } }),
    prisma.playerAvailability.createMany({ data: sportIds.map((sportId) => ({ profileId, sportId, startsAt, endsAt: until })) }),
  ]);
  // Only the moment someone goes from "not free" to "free" is news to their neighbours.
  if (!wasFree) runInBackground("nearby-available", () => notifyNearbyAvailable(profileId, sportIds));
  return getMyAvailability(userId, now);
}

export async function clearMyAvailability(userId: string) {
  const profileId = await profileIdOf(userId);
  await prisma.playerAvailability.deleteMany({ where: { profileId } });
  return { items: [] };
}

/** SQL fragment: this profile has a live row (optionally for one sport). */
export function availableNowSql(sportId: number | undefined, now: Date): Prisma.Sql {
  const sport = sportId === undefined ? Prisma.empty : Prisma.sql`AND pa."sportId" = ${sportId}`;
  // Bound as an ISO string cast to a zone-less timestamp (columns hold UTC) so the session time zone can't shift it.
  const utc = now.toISOString();
  return Prisma.sql`EXISTS (SELECT 1 FROM "PlayerAvailability" pa WHERE pa."profileId" = p.id AND pa."startsAt" <= ${utc}::timestamp AND pa."endsAt" > ${utc}::timestamp ${sport})`;
}

/** Which of these profiles are available right now (for the "available today" badge). */
export async function availableAmong(profileIds: string[], now = new Date()): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = await prisma.playerAvailability.findMany({
    where: { profileId: { in: profileIds }, startsAt: { lte: now }, endsAt: { gt: now } },
    select: { profileId: true },
    distinct: ["profileId"],
  });
  return new Set(rows.map((r) => r.profileId));
}

/** Job: rows past their window are already invisible to readers; this just keeps the table small. */
export async function sweepExpiredAvailability(now = new Date()) {
  const { count } = await prisma.playerAvailability.deleteMany({ where: { endsAt: { lte: now } } });
  return count ? { deleted: count } : null;
}
