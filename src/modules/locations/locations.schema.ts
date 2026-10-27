import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const id = z.coerce.number().int().positive();
export const districtsQuery = z.object({ divisionId: id });
export const upazilasQuery = z.object({ districtId: id });
export const unionsQuery = z.object({ upazilaId: id });
export const searchQuery = z.object({
  q: z.string().trim().min(2).max(60).openapi({ example: "kalap" }),
  level: z
    .enum(["district", "upazila", "union"])
    .optional()
    .openapi({ description: "Restrict to one level; omit to search all three." }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const Name = { id: z.number().int(), nameBn: z.string(), nameEn: z.string(), slug: z.string() };
const Ref = z.object({ id: z.number().int(), nameBn: z.string(), nameEn: z.string() });
const T = "Reference";
const list = (shape: z.ZodRawShape) => z.array(z.object({ ...Name, ...shape }));

registerRoute({ method: "get", path: "/locations/divisions", tag: T, summary: "List divisions", response: list({}) });
registerRoute({ method: "get", path: "/locations/districts", tag: T, summary: "Districts of a division", query: districtsQuery, response: list({ divisionId: z.number() }), errors: [422] });
registerRoute({ method: "get", path: "/locations/upazilas", tag: T, summary: "Upazilas of a district", query: upazilasQuery, response: list({ districtId: z.number() }), errors: [422] });
registerRoute({ method: "get", path: "/locations/unions", tag: T, summary: "Unions of an upazila", query: unionsQuery, response: list({ upazilaId: z.number() }), errors: [422] });
registerRoute({
  method: "get",
  path: "/locations/search",
  tag: T,
  summary: "Search places by Bangla or English name",
  query: searchQuery,
  response: z.array(
    z.object({ level: z.enum(["district", "upazila", "union"]), id: z.number(), nameBn: z.string(), nameEn: z.string(), district: Ref.nullable(), upazila: Ref.nullable() }),
  ),
  errors: [422],
});
