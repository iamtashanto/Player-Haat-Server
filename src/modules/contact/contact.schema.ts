import { registerRoute } from "../../lib/openapi.js";
import { pageQuery } from "../../lib/pagination.js";
import { z } from "../../lib/zod.js";

export const contactViewsQuery = pageQuery;
const profileId = z.object({ id: z.string().min(1).max(40) });

const Status = z.object({
  state: z.enum(["SELF", "OPEN", "RELATED", "LOCKED"]).openapi({ description: "OPEN: one tap shows it · RELATED: you've accepted each other (always free) · LOCKED: the player shares only with people they accept." }),
  visibility: z.enum(["ON_TAP", "AFTER_ACCEPT"]),
  hasPhone: z.boolean(),
  alreadyRevealed: z.boolean(),
  cost: z.number().int().openapi({ description: "Credits the next tap would cost (0 = free)." }),
  freeLeftToday: z.number().int().nullable(),
  balance: z.number().int().nullable(),
});
const T = "Contact";
registerRoute({ method: "get", path: "/players/{id}/contact", tag: T, summary: "Can I see this player's number, and what would it cost?", auth: true, params: profileId, response: Status, errors: [403, 404] });
registerRoute({ method: "post", path: "/players/{id}/contact", tag: T, summary: "Show this player's number", description: "One tap, no approval needed unless the player chose 'after I accept'. The player is told you looked. Opening the same number again is free. Beyond the free daily allowance it costs credits (when monetisation is on): 402 `CREDITS_REQUIRED`.", auth: true, params: profileId, response: z.object({ phone: z.string().nullable(), cost: z.number().int(), balance: z.number().int().nullable() }), errors: [402, 403, 404, 409] });
registerRoute({ method: "get", path: "/players/me/contact-views", tag: T, summary: "Who has looked at my number", auth: true, query: contactViewsQuery, response: z.array(z.object({ id: z.string(), createdAt: z.string().datetime(), viewer: z.object({ name: z.string(), avatarUrl: z.string().nullable(), role: z.string(), recruiterId: z.string().nullable(), recruiterType: z.string().nullable(), organization: z.string().nullable(), verified: z.boolean() }) })), errors: [403, 422] });
