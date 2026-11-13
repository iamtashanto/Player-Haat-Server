import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../notifications/notifier.js";

/**
 * Rain outlook for a game, from Open-Meteo (free, no key). Only the centre of the game's upazila (or district) is sent:
 * no user data. Answers are kept for 30 minutes, so many people opening one game cost one call.
 */
export type RainLevel = "LIKELY" | "POSSIBLE" | "UNLIKELY";
export interface Outlook { level: RainLevel; rainChance: number; rainMm: number }

export const weatherDeps = { fetch: (url: string, init?: RequestInit) => fetch(url, init) as Promise<Response> };

const TTL_MS = 30 * 60 * 1000;
const HORIZON_MS = 14 * 24 * 3_600_000; // Open-Meteo forecasts reach 16 days; stay inside what is reliable
const cache = new Map<string, { at: number; hours: { t: number; p: number; mm: number }[] }>();
export const clearWeatherCache = () => cache.clear();

export const levelOf = (rainChance: number, rainMm: number): RainLevel => (rainChance >= 60 || rainMm >= 2 ? "LIKELY" : rainChance >= 30 ? "POSSIBLE" : "UNLIKELY");

async function hourly(lat: number, lng: number) {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`; // ~10 km cells: neighbouring grounds share one forecast
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hours;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&hourly=precipitation_probability,precipitation&timezone=UTC&forecast_days=16`;
  const res = await weatherDeps.fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = (await res.json()) as { hourly?: { time?: string[]; precipitation_probability?: (number | null)[]; precipitation?: (number | null)[] } };
  const h = j.hourly;
  if (!h?.time) throw new Error("open-meteo: no hourly data");
  const hours = h.time.map((t, i) => ({ t: Date.parse(`${t}:00Z`), p: h.precipitation_probability?.[i] ?? 0, mm: h.precipitation?.[i] ?? 0 }));
  cache.set(key, { at: Date.now(), hours });
  return hours;
}

/** The outlook for the two hours of play, or null when it can't be known (too far ahead, past, or the service is down). */
export async function outlookFor(lat: number | null | undefined, lng: number | null | undefined, matchAt: Date): Promise<Outlook | null> {
  if (lat == null || lng == null) return null;
  const now = Date.now();
  if (matchAt.getTime() <= now || matchAt.getTime() > now + HORIZON_MS) return null;
  try {
    const from = matchAt.getTime();
    const slice = (await hourly(lat, lng)).filter((h) => h.t >= from - 3_600_000 + 1 && h.t <= from + 2 * 3_600_000);
    if (slice.length === 0) return null;
    const rainChance = Math.round(Math.max(...slice.map((h) => h.p)));
    const rainMm = Math.round(slice.reduce((s, h) => s + h.mm, 0) * 10) / 10;
    return { level: levelOf(rainChance, rainMm), rainChance, rainMm };
  } catch (err) {
    logger.warn({ err }, "weather lookup failed");
    return null;
  }
}

const gameWithPlace = {
  id: true, matchAt: true, venueText: true, createdById: true, isHidden: true, status: true, kind: true,
  sport: { select: { nameBn: true, nameEn: true } },
  venueLat: true,
  venueLng: true,
  upazila: { select: { lat: true, lng: true } },
  district: { select: { lat: true, lng: true } },
} as const;

export async function outlookForRequest(requestId: string): Promise<Outlook | null> {
  const r = await prisma.playerRequest.findUnique({ where: { id: requestId }, select: gameWithPlace });
  if (!r || r.isHidden) return null;
  return outlookFor(r.venueLat ?? r.upazila.lat ?? r.district.lat, r.venueLng ?? r.upazila.lng ?? r.district.lng, r.matchAt);
}

/**
 * Within a day of kick-off, tell the organiser and accepted players once if rain looks likely, so nobody makes a wasted trip.
 * One alert per game (the marker is stored on the game), safe to run on several instances.
 */
export async function sendRainAlerts(now = new Date()): Promise<number> {
  const games = await prisma.playerRequest.findMany({
    where: { kind: "MATCH", isHidden: false, status: { in: ["OPEN", "FILLED"] }, rainAlertedAt: null, matchAt: { gt: new Date(now.getTime() + 60 * 60_000), lte: new Date(now.getTime() + 24 * 3_600_000) } },
    select: gameWithPlace,
    take: 100,
  });
  let sent = 0;
  for (const g of games) {
    const outlook = await outlookFor(g.venueLat ?? g.upazila.lat ?? g.district.lat, g.venueLng ?? g.upazila.lng ?? g.district.lng, g.matchAt);
    if (!outlook || outlook.level !== "LIKELY") continue;
    // claim it first: only one instance sends
    const claimed = await prisma.playerRequest.updateMany({ where: { id: g.id, rainAlertedAt: null }, data: { rainAlertedAt: now } });
    if (claimed.count === 0) continue;
    const accepted = await prisma.application.findMany({ where: { requestId: g.id, status: "ACCEPTED" }, select: { playerId: true } });
    notify({
      userIds: [g.createdById, ...accepted.map((a) => a.playerId)],
      type: "RAIN_ALERT",
      data: { requestId: g.id },
      params: { sport: { bn: g.sport.nameBn, en: g.sport.nameEn }, venue: g.venueText, when: g.matchAt, text: `${outlook.rainChance}%` },
    });
    sent++;
  }
  return sent;
}
