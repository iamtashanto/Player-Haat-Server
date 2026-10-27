import { prisma } from "../../lib/prisma.js";
import { z } from "../../lib/zod.js";

/** The only keys the app understands, and the shape each value must have. Admins can't invent keys. */
export const CONFIG_SCHEMAS = {
  ads_enabled: z.boolean(),
  boost_enabled: z.boolean(),
  min_app_version: z.string().regex(/^\d+(\.\d+){0,2}$/, "Use a version like 1.4.0"),
} as const;
export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

const DEFAULTS: Record<ConfigKey, boolean | string> = { ads_enabled: false, boost_enabled: false, min_app_version: "0.0.0" };

export interface PublicConfig {
  flags: { ads_enabled: boolean; boost_enabled: boolean };
  minAppVersion: string;
}

// Every app launch hits this, so keep a short in-process cache. Admin writes clear it immediately;
// other instances catch up within the TTL.
const TTL_MS = 30_000;
let cache: { at: number; value: PublicConfig } | undefined;
export const clearConfigCache = () => {
  cache = undefined;
};

export async function readAll(): Promise<Record<ConfigKey, unknown>> {
  const rows = await prisma.appConfig.findMany();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(CONFIG_KEYS.map((k) => {
    const parsed = CONFIG_SCHEMAS[k].safeParse(stored.get(k));
    return [k, parsed.success ? parsed.data : DEFAULTS[k]]; // a corrupt row falls back to the default, never breaks the app
  })) as Record<ConfigKey, unknown>;
}

export async function getPublicConfig(): Promise<PublicConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const all = await readAll();
  const value: PublicConfig = {
    flags: { ads_enabled: all.ads_enabled as boolean, boost_enabled: all.boost_enabled as boolean },
    minAppVersion: all.min_app_version as string,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Numeric dotted-version compare ("1.10.0" > "1.9.2"). Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
