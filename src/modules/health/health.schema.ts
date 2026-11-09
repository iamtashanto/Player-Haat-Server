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

// Health is served at the root (/health, for load balancers) and under the versioned prefix (/api/v1/health).
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

for (const [path, summary] of [["/api/v1/health", "Liveness probe (versioned path)"], ["/api/v1/health/ready", "Readiness probe (versioned path)"]] as const) {
  registry.registerPath({
    method: "get",
    path,
    tags: ["System"],
    summary,
    servers: [{ url: "/" }],
    responses: { 200: { description: "OK", content: { "application/json": { schema: envelope(LivenessSchema) } } } },
  });
}
