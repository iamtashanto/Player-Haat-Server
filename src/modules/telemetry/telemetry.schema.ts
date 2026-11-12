import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const name = z.string().regex(/^[A-Za-z0-9_.:-]{1,48}$/, "Use letters, digits and _ . : - (max 48)");
const prop = z.union([z.string().max(80), z.number(), z.boolean()]);

export const eventBody = z.object({
  kind: z.enum(["ERROR", "EVENT"]),
  name,
  route: z.string().max(200).optional(),
  message: z.string().max(600).optional(),
  stack: z.string().max(4000).optional(),
  props: z.record(z.string().max(24), prop).refine((p) => Object.keys(p).length <= 8, "At most 8 properties").optional(),
});

export const batchBody = z.object({
  platform: z.enum(["WEB", "ANDROID", "IOS"]),
  appVersion: z.string().max(20).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  locale: z.enum(["bn", "en"]).optional(),
  events: z.array(eventBody).min(1).max(20),
});

export const summaryQuery = z.object({ days: z.coerce.number().int().refine((d) => [1, 7, 14, 30, 90].includes(d), "1, 7, 14, 30 or 90").default(7) });

registerRoute({
  method: "post",
  path: "/telemetry",
  tag: "Telemetry",
  summary: "Send crash and usage events (first-party, anonymous)",
  description:
    "Batches of up to 20 error or funnel events from the web or the app. No account id and no IP address are stored; `sessionId` is a random id per tab or install. " +
    "Emails, phone numbers and tokens are scrubbed from messages and properties. Rows are deleted after 90 days. Answers 200 with how many events were kept (0 when telemetry is switched off).",
  body: batchBody,
  response: z.object({ accepted: z.number().int() }),
  errors: [422, 429],
});
registerRoute({
  method: "get",
  path: "/admin/telemetry/summary",
  tag: "Admin",
  summary: "Health: grouped errors and the sign-up funnel",
  auth: true,
  query: summaryQuery,
  response: z.record(z.string(), z.unknown()),
  errors: [403, 422],
});
