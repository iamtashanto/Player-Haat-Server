import { z } from "../../lib/zod.js";
import { AppError } from "../../lib/errors.js";

/**
 * Self-declared performance numbers for a sport profile, stored as JSON on PlayerSport.stats.
 *
 * Each sport gets its own strict shape (unknown keys are rejected, so the column can't turn into a
 * junk drawer). Adding a sport's stats is one entry here — no migration. Sports without an entry
 * accept only `matches`. These numbers are the player's own claim, not verified by the platform.
 */
const count = z.number().int().min(0).max(100_000);
const average = z.number().min(0).max(1_000);

const GENERIC = z.strictObject({ matches: count.optional() });

export const STATS_SCHEMAS: Record<string, z.ZodType<Record<string, number>>> = {
  FOOTBALL: z.strictObject({
    matches: count.optional(),
    goals: count.optional(),
    assists: count.optional(),
    cleanSheets: count.optional(),
  }),
  CRICKET: z.strictObject({
    matches: count.optional(),
    runs: count.optional(),
    wickets: count.optional(),
    highestScore: count.optional(),
    battingAverage: average.optional(),
  }),
};

const DECIMAL_STATS = new Set(["battingAverage"]);

/** Display names for every stat key above, in both app languages. A test fails if a schema key has no entry. */
export const STAT_LABELS: Record<string, { nameEn: string; nameBn: string }> = {
  matches: { nameEn: "Matches", nameBn: "ম্যাচ" },
  goals: { nameEn: "Goals", nameBn: "গোল" },
  assists: { nameEn: "Assists", nameBn: "অ্যাসিস্ট" },
  cleanSheets: { nameEn: "Clean sheets", nameBn: "ক্লিন শিট" },
  runs: { nameEn: "Runs", nameBn: "রান" },
  wickets: { nameEn: "Wickets", nameBn: "উইকেট" },
  highestScore: { nameEn: "Highest score", nameBn: "সর্বোচ্চ স্কোর" },
  battingAverage: { nameEn: "Batting average", nameBn: "ব্যাটিং গড়" },
};

/** Every stat key any sport accepts. */
export const allStatKeys = (): string[] => [...new Set([...Object.values(STATS_SCHEMAS).flatMap((s) => Object.keys((s as unknown as { shape: object }).shape)), "matches"])];

/**
 * What the app renders for a sport's stats form — derived from the validation schema above (so the form and
 * the API can't drift), with labels so the app needs no translations of its own for stats.
 */
export function statFieldsFor(sportCode: string): Array<{ key: string; decimal: boolean; nameEn: string; nameBn: string }> {
  const schema = STATS_SCHEMAS[sportCode] as unknown as { shape?: Record<string, unknown> } | undefined;
  const keys = schema?.shape ? Object.keys(schema.shape) : ["matches"];
  return keys.map((key) => ({ key, decimal: DECIMAL_STATS.has(key), nameEn: STAT_LABELS[key]?.nameEn ?? key, nameBn: STAT_LABELS[key]?.nameBn ?? key }));
}

/** Returns the cleaned stats (or null when there's nothing to store); throws a 422 on `stats` otherwise. */
export function parseStats(sportCode: string, raw: unknown): Record<string, number> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = (STATS_SCHEMAS[sportCode] ?? GENERIC).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? `stats.${issue.path.join(".")}` : "stats";
    throw AppError.invalid(where, issue.message);
  }
  const clean = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  return Object.keys(clean).length ? clean : null;
}
