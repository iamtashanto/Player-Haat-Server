import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";

export const MAX_LINKS = 3;
export const MAX_IMAGES = 3;

const link = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an https link");
const image = z.strictObject({ publicId: z.string().min(10).max(300).openapi({ description: "From POST /media/images with type `verification-doc`." }) });

const evidence = {
  note: z.string().trim().min(1).max(500).optional(),
  evidenceLinks: z.array(link).max(MAX_LINKS).default([]),
  evidenceImages: z.array(image).max(MAX_IMAGES).default([]),
};
const needsEvidence = (b: { evidenceLinks: unknown[]; evidenceImages: unknown[] }) => b.evidenceLinks.length + b.evidenceImages.length > 0;
const NEEDS = { message: "Add at least one link or document", path: ["evidenceLinks"] };

export const submitRecruiterBody = z.strictObject(evidence).refine(needsEvidence, NEEDS);
export const submitStatsBody = z.strictObject(evidence).refine(needsEvidence, NEEDS);
export const sportParams = z.object({ sportId: z.coerce.number().int().positive() });

export const adminQuery = pageQuery.extend({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).default("PENDING"),
  kind: z.enum(["RECRUITER", "PLAYER_STATS"]).optional(),
});
export const reviewBody = z
  .strictObject({ approve: z.boolean(), note: z.string().trim().min(3).max(500).optional() })
  .refine((b) => b.approve || !!b.note, { message: "Say why it wasn't approved", path: ["note"] });
export const verificationParams = z.object({ id: z.string().min(1).max(40) });

const Status = z.object({
  id: z.string(),
  kind: z.enum(["RECRUITER", "PLAYER_STATS"]),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  note: z.string().nullable(),
  evidenceLinks: z.array(z.string()),
  evidenceImages: z.array(z.object({ url: z.string() })),
  reviewNote: z.string().nullable().openapi({ description: "Why it was rejected." }),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
});
const T = "Verification";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/recruiters/me/verification", ...A, summary: "Ask to be verified (recruiters)", description: "Send links (a club page, a federation listing) and/or photos of documents (upload with type `verification-doc`). An admin reviews it; approval adds the verified badge players see.", body: submitRecruiterBody, response: Status, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/recruiters/me/verification", ...A, summary: "My latest verification request", response: Status.nullable(), errors: [403] });
registerRoute({ method: "post", path: "/players/me/sports/{sportId}/verification", ...A, summary: "Ask to have the stats on a sport profile verified (players)", description: "Needs stats on that profile. Approval shows a 'stats verified' mark; changing the stats afterwards removes it.", params: sportParams, body: submitStatsBody, response: Status, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/players/me/sports/{sportId}/verification", ...A, summary: "My latest stats-verification request for a sport", params: sportParams, response: Status.nullable(), errors: [403, 404] });
