import type { PrismaClient } from "@prisma/client";

export const DEFAULT_APP_CONFIG: Record<string, unknown> = {
  ads_enabled: false,
  boost_enabled: false,
  min_app_version: "1.0.0",
};

/** Inserts missing flags only — never overwrites a value an admin has changed. */
export async function seedAppConfig(prisma: PrismaClient) {
  for (const [key, value] of Object.entries(DEFAULT_APP_CONFIG)) {
    await prisma.appConfig.upsert({
      where: { key },
      update: {},
      create: { key, value: value as never },
    });
  }
  return { flags: Object.keys(DEFAULT_APP_CONFIG).length };
}
