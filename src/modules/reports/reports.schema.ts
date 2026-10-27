import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const REPORT_REASONS = ["FAKE_PROFILE", "HARASSMENT", "SPAM", "SCAM_OR_PAYMENT", "INAPPROPRIATE_CONTENT", "FALSE_NO_SHOW", "OTHER"] as const;
/** What a client can report. People are reported through their profile or request — user ids are never exposed. */
export const REPORTABLE = ["PLAYER_PROFILE", "REQUEST", "TEAM", "RATING", "CONVERSATION"] as const;

export const createReportBody = z
  .strictObject({
    targetType: z.enum(REPORTABLE),
    targetId: z.string().min(1).max(40).openapi({ description: "Profile id, request id, team id, rating id or conversation id." }),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => b.reason !== "OTHER" || (b.details && b.details.length >= 5), { message: "Tell us what's wrong (at least 5 characters)", path: ["details"] });

registerRoute({
  method: "post",
  path: "/reports",
  tag: "Reports",
  summary: "Report a profile, request, team or rating",
  description: "One open report per target per person. You can't report your own content.",
  auth: true,
  body: createReportBody,
  response: z.object({ id: z.string(), status: z.literal("OPEN"), createdAt: z.string().datetime() }),
  status: 201,
  errors: [404, 409, 422],
});
