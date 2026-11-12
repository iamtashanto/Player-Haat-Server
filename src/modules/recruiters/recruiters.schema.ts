import { RecruiterType } from "@prisma/client";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const intId = z.number().int().positive();
export const MAX_RECRUITER_SPORTS = 10;

const type = z.enum(Object.values(RecruiterType) as [RecruiterType, ...RecruiterType[]]); // one source of truth with the DB enum
const organization = z.string().trim().min(1).max(100);
const bio = z.string().trim().min(1).max(500);
const sportIds = z.array(intId).min(1).max(MAX_RECRUITER_SPORTS).refine((a) => new Set(a).size === a.length, "Duplicate sport");

export const createRecruiterBody = z.strictObject({
  type,
  organization: organization.nullable().optional(),
  bio: bio.nullable().optional(),
  districtId: intId,
  sportIds,
});
export const updateRecruiterBody = z
  .strictObject({ type, organization: organization.nullable(), bio: bio.nullable(), districtId: intId, sportIds })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field");
export const recruiterParams = z.object({ id: z.string().min(1).max(40) });

const Ref = z.object({ id: z.number(), nameBn: z.string(), nameEn: z.string() });
const RecruiterCard = z
  .object({
    id: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
    type,
    organization: z.string().nullable(),
    bio: z.string().nullable(),
    district: Ref,
    sportIds: z.array(z.number().int()),
    verifiedBadge: z.boolean(),
    rating: z.object({ average: z.number(), count: z.number().int(), isNew: z.boolean() }).openapi({ description: "Reviews from players this organiser has hosted. `isNew` until 3 are revealed (then `average` is 0)." }),
    logoUrl: z.string().nullable().openapi({ description: "Organisation logo (original size; use the `/img/` renditions to display)." }),
  })
  .openapi("RecruiterProfile");

const T = "Recruiters";
registerRoute({ method: "get", path: "/recruiters/me", tag: T, summary: "My recruiter profile", description: "Recruiters only. 404 until onboarding is done — until then player discovery is closed to the recruiter.", auth: true, response: RecruiterCard, errors: [403, 404] });
registerRoute({ method: "post", path: "/recruiters/me", tag: T, summary: "Create my recruiter profile (onboarding)", auth: true, body: createRecruiterBody, response: RecruiterCard, status: 201, errors: [403, 409, 422] });
registerRoute({ method: "patch", path: "/recruiters/me", tag: T, summary: "Update my recruiter profile", auth: true, body: updateRecruiterBody, response: RecruiterCard, errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/recruiters/{id}", tag: T, summary: "A recruiter's public card", description: "So players can see who is contacting them. Visible to players and recruiters.", auth: true, params: recruiterParams, response: RecruiterCard, errors: [404] });
registerRoute({ method: "put", path: "/recruiters/me/logo", tag: T, summary: "Set my organisation logo", description: "multipart/form-data, field `file`. The previous logo is deleted.", auth: true, multipart: z.object({ file: z.string().openapi({ type: "string", format: "binary" }) }), response: RecruiterCard, errors: [403, 404, 413, 415, 422, 502, 503] });
registerRoute({ method: "delete", path: "/recruiters/me/logo", tag: T, summary: "Remove my organisation logo", auth: true, response: RecruiterCard, errors: [403, 404] });
