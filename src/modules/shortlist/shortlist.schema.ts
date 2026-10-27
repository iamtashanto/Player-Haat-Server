import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";

export const MAX_SHORTLIST = 500;
export const profileParams = z.object({ profileId: z.string().min(1).max(40) });
export const saveBody = z.strictObject({ note: z.string().trim().min(1).max(300).nullable().optional() }).default({});
export const shortlistQuery = pageQuery.extend({ sportId: z.coerce.number().int().positive().optional() });

const T = "Shortlist";
const A = { tag: T, auth: true } as const;
registerRoute({ method: "get", path: "/shortlist", ...A, summary: "My saved players (recruiters)", description: "Newest first. Players who are no longer visible (hidden, suspended, switched role) drop out of the list and come back if they return.", query: shortlistQuery, response: z.array(z.object({ savedAt: z.string().datetime(), note: z.string().nullable(), player: z.record(z.string(), z.unknown()) })), errors: [403, 422] });
registerRoute({ method: "put", path: "/shortlist/{profileId}", ...A, summary: "Save a player, or update my note on them", description: `Up to ${MAX_SHORTLIST}. Private: the player isn't told.`, params: profileParams, body: saveBody, response: z.object({ profileId: z.string(), note: z.string().nullable(), savedAt: z.string().datetime() }), errors: [403, 404, 409, 422] });
registerRoute({ method: "delete", path: "/shortlist/{profileId}", ...A, summary: "Remove a saved player", params: profileParams, response: z.object({ removed: z.boolean() }), errors: [403] });
