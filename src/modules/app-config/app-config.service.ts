import { prisma } from "../../lib/prisma.js";
import { z } from "../../lib/zod.js";

/** The only keys the app understands, and the shape each value must have. Admins can't invent keys. */
export const CONFIG_SCHEMAS = {
  ads_enabled: z.boolean(),
  boost_enabled: z.boolean(),
  min_app_version: z.string().regex(/^\d+(\.\d+){0,2}$/, "Use a version like 1.4.0"),
  // Monetisation. With contact_credits_enabled off everything stays free, whatever the numbers below say.
  contact_credits_enabled: z.boolean(),
  // Admin input arrives as a string ("5") over the config endpoint, so these coerce to integers.
  contact_free_per_day: z.coerce.number().int().min(0).max(1000),
  contact_credit_cost: z.coerce.number().int().min(0).max(100),
  boost_credit_cost: z.coerce.number().int().min(1).max(1000),
  boost_hours: z.coerce.number().int().min(1).max(720),
} as const;
export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

const DEFAULTS: Record<ConfigKey, boolean | string | number> = {
  ads_enabled: false,
  boost_enabled: false,
  min_app_version: "0.0.0",
  contact_credits_enabled: false,
  contact_free_per_day: 5,
  contact_credit_cost: 1,
  boost_credit_cost: 10,
  boost_hours: 48,
};

/** What things cost right now. The app shows these before asking the user to spend anything. */
export interface Pricing {
  contactCreditsEnabled: boolean;
  freeContactsPerDay: number;
  contactCreditCost: number;
  boostCreditCost: number;
  boostHours: number;
}

export interface PublicConfig {
  flags: { ads_enabled: boolean; boost_enabled: boolean; contact_credits_enabled: boolean };
  pricing: Pricing;
  minAppVersion: string;
}

// Every app launch hits this, so keep a short in-process cache. Admin writes clear it immediately;
// other instances catch up within the TTL.
const TTL_MS = 30_000;
let cache: { at: number; value: PublicConfig } | undefined;
export const clearConfigCache = () => {
  cache = undefined;
};

export const pricingFrom = (all: Record<ConfigKey, unknown>): Pricing => ({
  contactCreditsEnabled: all.contact_credits_enabled as boolean,
  freeContactsPerDay: all.contact_free_per_day as number,
  contactCreditCost: all.contact_credit_cost as number,
  boostCreditCost: all.boost_credit_cost as number,
  boostHours: all.boost_hours as number,
});

/** Current prices, read through the same short cache as the public config. */
export async function getPricing(): Promise<Pricing> {
  return (await getPublicConfig()).pricing;
}

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
    flags: { ads_enabled: all.ads_enabled as boolean, boost_enabled: all.boost_enabled as boolean, contact_credits_enabled: all.contact_credits_enabled as boolean },
    pricing: pricingFrom(all),
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
