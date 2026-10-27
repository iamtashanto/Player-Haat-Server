import { RecruiterType } from "@prisma/client";

/**
 * Display names for each recruiter type. Typed as an exhaustive record, so adding a value to the Prisma enum
 * without a label here is a compile error — the app never shows a raw code.
 */
const LABELS: Record<RecruiterType, { nameEn: string; nameBn: string }> = {
  CLUB: { nameEn: "Club", nameBn: "ক্লাব" },
  ACADEMY: { nameEn: "Academy", nameBn: "একাডেমি" },
  SCOUT: { nameEn: "Scout", nameBn: "স্কাউট" },
  AGENT: { nameEn: "Agent", nameBn: "এজেন্ট" },
  ORGANIZER: { nameEn: "Organizer", nameBn: "আয়োজক" },
  OTHER: { nameEn: "Other", nameBn: "অন্যান্য" },
};

export const listRecruiterTypes = () => Object.values(RecruiterType).map((code) => ({ code, ...LABELS[code] }));
