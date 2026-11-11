/** Bangladesh has no DST: Asia/Dhaka is a fixed UTC+6, so day boundaries are plain arithmetic. */
const OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant the current Dhaka calendar day ends (next 00:00 Asia/Dhaka). */
export function endOfDhakaDay(now: Date): Date {
  const local = now.getTime() + OFFSET_MS;
  return new Date((Math.floor(local / DAY_MS) + 1) * DAY_MS - OFFSET_MS);
}

/** Today's `HH:MM` (Dhaka wall clock) as an instant; null when the string isn't a valid time. */
export function dhakaTimeToday(now: Date, hhmm: string): Date | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const startOfDay = endOfDhakaDay(now).getTime() - DAY_MS;
  return new Date(startOfDay + (Number(m[1]) * 60 + Number(m[2])) * 60_000);
}
