import { envelope, errorResponses, registry } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

const LivenessSchema = z.object({
  status: z.literal("ok"),
  uptimeSec: z.number().int(),
});

const ReadinessSchema = z.object({
  status: z.literal("ok"),
  db: z.object({ ok: z.boolean(), latencyMs: z.number() }),
});

// NOTE: health lives at the server root (/health), not under /api/v1.
registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Liveness probe",
  servers: [{ url: "/" }],
  responses: {
    200: { description: "Process is up", content: { "application/json": { schema: envelope(LivenessSchema) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/health/ready",
  tags: ["System"],
  summary: "Readiness probe (checks the database)",
  servers: [{ url: "/" }],
  responses: {
    200: { description: "Ready", content: { "application/json": { schema: envelope(ReadinessSchema) } } },
    ...errorResponses(),
    503: { description: "Database unreachable" },
  },
});
