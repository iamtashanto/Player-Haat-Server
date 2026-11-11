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

const evidence = {
  note: z.string().trim().min(1).max(500).optional(),
  evidenceLinks: z.array(link).max(MAX_LINKS).default([]),
  fileIds: z.array(z.string().min(1).max(40)).max(MAX_IMAGES).default([]).openapi({ description: "Ids from `POST /verification/files`." }),
};
const needsEvidence = (b: { evidenceLinks: unknown[]; fileIds: unknown[] }) => b.evidenceLinks.length + b.fileIds.length > 0;
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
export const fileParams = z.object({ fileId: z.string().min(1).max(40) });
export const adminFileParams = z.object({ id: z.string().min(1).max(40), fileId: z.string().min(1).max(40) });
const binary = z.string().openapi({ type: "string", format: "binary" });

const Status = z.object({
  id: z.string(),
  kind: z.enum(["RECRUITER", "PLAYER_STATS"]),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  note: z.string().nullable(),
  evidenceLinks: z.array(z.string()),
  files: z.array(z.object({ id: z.string(), mime: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable() })).openapi({ description: "Documents. Open one with `GET /verification/files/{fileId}` (yours only); there is no public URL." }),
  reviewNote: z.string().nullable().openapi({ description: "Why it was rejected." }),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
});
const T = "Verification";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "post", path: "/recruiters/me/verification", ...A, summary: "Ask to be verified (recruiters)", description: "Send links (a club page, a federation listing) and/or photos of documents (upload each with `POST /verification/files`). An admin reviews it; approval adds the verified badge players see.", body: submitRecruiterBody, response: Status, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/recruiters/me/verification", ...A, summary: "My latest verification request", response: Status.nullable(), errors: [403] });
registerRoute({ method: "post", path: "/players/me/sports/{sportId}/verification", ...A, summary: "Ask to have the stats on a sport profile verified (players)", description: "Needs stats on that profile. Approval shows a 'stats verified' mark; changing the stats afterwards removes it.", params: sportParams, body: submitStatsBody, response: Status, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/players/me/sports/{sportId}/verification", ...A, summary: "My latest stats-verification request for a sport", params: sportParams, response: Status.nullable(), errors: [403, 404] });
registerRoute({ method: "post", path: "/verification/files", ...A, summary: "Upload a verification document (image)", description: "multipart/form-data, field `file` (jpeg/png/webp, max 5 MB). Stored encrypted; nobody but you and a reviewing admin can open it.", multipart: z.object({ file: binary }), response: z.object({ id: z.string(), mime: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable() }), status: 201, errors: [413, 415, 422, 429, 502, 503] });
registerRoute({ method: "get", path: "/verification/files/{fileId}", ...A, summary: "Open one of my own verification documents", description: "Streams the picture. 404 for anyone else's.", params: fileParams, errors: [401, 404] });
registerRoute({ method: "get", path: "/admin/verification/{id}/files/{fileId}", ...A, summary: "Open a document attached to a verification request (admin)", description: "Streams the decrypted picture, never cached; every view is written to the audit log.", params: adminFileParams, errors: [401, 403, 404] });
