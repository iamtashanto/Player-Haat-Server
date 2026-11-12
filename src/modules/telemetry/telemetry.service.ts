import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import type { batchBody } from "./telemetry.schema.js";

type Batch = z.infer<typeof batchBody>;

/** Anything that could identify a person is replaced before it is stored. */
const SCRUBS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [token]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[jwt]"],
  [/(?:\+?88)?01[3-9]\d{8}/g, "[phone]"],
  [/\b\d{9,}\b/g, "[number]"],
];
export const scrub = (s: string): string => SCRUBS.reduce((acc, [re, to]) => acc.replace(re, to), s);

/** `/en/request/cmw8abc…` → `/request/:id`: no locale prefix, no query, ids collapsed so routes group. */
export function normalizeRoute(route: string | undefined): string | null {
  if (!route) return null;
  const path = route.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "en" || parts[0] === "bn") parts.shift();
  return "/" + parts.map((p) => (/^[a-z0-9_-]{16,}$/i.test(p) || /^\d+$/.test(p) ? ":id" : p)).join("/").slice(0, 120);
}

/** Same error, different ids or numbers → same fingerprint. */
export function fingerprint(name: string, message: string | undefined, stack: string | undefined): string {
  const norm = (s: string) => s.replace(/\b[a-z0-9]{12,}\b/gi, ":id").replace(/\d+/g, "#").slice(0, 200);
  const frame = (stack ?? "").split("\n").find((l) => /at |@|\.dart|\.js|\.ts/.test(l)) ?? "";
  return createHash("sha1").update(`${name}|${norm(message ?? "")}|${norm(frame)}`).digest("hex").slice(0, 16);
}

function cleanProps(props: Record<string, string | number | boolean> | undefined): Prisma.InputJsonObject | undefined {
  if (!props) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) out[k] = typeof v === "string" ? scrub(v) : v;
  return out;
}

export async function ingest(b: Batch): Promise<number> {
  if (!env.TELEMETRY_ENABLED) return 0;
  const rows = b.events.map((e) => {
    const message = e.message ? scrub(e.message) : undefined;
    const stack = e.stack ? scrub(e.stack) : undefined;
    return {
      kind: e.kind,
      name: e.name,
      platform: b.platform,
      appVersion: b.appVersion ?? null,
      sessionId: b.sessionId,
      locale: b.locale ?? null,
      route: normalizeRoute(e.route),
      message: message ?? null,
      stack: stack ?? null,
      fingerprint: e.kind === "ERROR" ? fingerprint(e.name, message, stack) : null,
      props: cleanProps(e.props),
    };
  });
  const res = await prisma.telemetryEvent.createMany({ data: rows });
  return res.count;
}

/** The order the funnel is read in; anything else follows alphabetically. */
const FUNNEL = ["signup_started", "signup_completed", "setup_completed", "request_posted", "application_sent", "application_accepted", "attendance_marked", "rating_given", "share_clicked"];

export async function summary(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const [errors, funnel, platforms, sessions] = await Promise.all([
    prisma.$queryRaw<{ fingerprint: string; name: string; message: string | null; route: string | null; count: number; sessions: number; platforms: string[]; firstSeen: Date; lastSeen: Date; stack: string | null }[]>`
      SELECT fingerprint,
             (array_agg(name ORDER BY at DESC))[1] AS name,
             (array_agg(message ORDER BY at DESC))[1] AS message,
             (array_agg(route ORDER BY at DESC))[1] AS route,
             (array_agg(stack ORDER BY at DESC))[1] AS stack,
             COUNT(*)::int AS count, COUNT(DISTINCT "sessionId")::int AS sessions,
             array_agg(DISTINCT platform) AS platforms, MIN(at) AS "firstSeen", MAX(at) AS "lastSeen"
      FROM "TelemetryEvent" WHERE kind = 'ERROR' AND at >= ${since} AND fingerprint IS NOT NULL AND "appVersion" IS DISTINCT FROM 'e2e'
      GROUP BY fingerprint ORDER BY count DESC, "lastSeen" DESC LIMIT 25`,
    prisma.$queryRaw<{ name: string; count: number; sessions: number }[]>`
      SELECT name, COUNT(*)::int AS count, COUNT(DISTINCT "sessionId")::int AS sessions
      FROM "TelemetryEvent" WHERE kind = 'EVENT' AND at >= ${since} AND "appVersion" IS DISTINCT FROM 'e2e' GROUP BY name`,
    prisma.$queryRaw<{ platform: string; sessions: number }[]>`
      SELECT platform, COUNT(DISTINCT "sessionId")::int AS sessions FROM "TelemetryEvent" WHERE at >= ${since} AND "appVersion" IS DISTINCT FROM 'e2e' GROUP BY platform ORDER BY sessions DESC`,
    prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "sessionId")::int AS n FROM "TelemetryEvent" WHERE at >= ${since} AND "appVersion" IS DISTINCT FROM 'e2e'`,
  ]);
  const rank = (n: string) => (FUNNEL.includes(n) ? FUNNEL.indexOf(n) : 100);
  return {
    days,
    enabled: env.TELEMETRY_ENABLED,
    sessions: sessions[0]?.n ?? 0,
    platforms,
    errors: errors.map((e) => ({ ...e, firstSeen: e.firstSeen.toISOString(), lastSeen: e.lastSeen.toISOString() })),
    funnel: funnel.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)),
  };
}

/** Called by the purge job. */
export const purgeTelemetry = (olderThan: Date) => prisma.telemetryEvent.deleteMany({ where: { at: { lt: olderThan } } }).then((r) => r.count);
