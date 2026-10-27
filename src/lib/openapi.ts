import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { env } from "../config/env.js";
import { API_PREFIX } from "../config/constants.js";
import { z } from "./zod.js";
import type { RouteConfig } from "@asteasolutions/zod-to-openapi";

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({
      code: z.string().openapi({ example: "VALIDATION_ERROR" }),
      message: z.string().openapi({ description: "Developer-facing; the app translates `code`." }),
      details: z.unknown().optional(),
    }),
  }),
);

/** Wraps a payload schema in the standard `{ data, meta }` envelope. */
export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, meta: z.record(z.string(), z.unknown()).optional() });

/** Shared error responses to spread into `registerPath({ responses })`. */
export const errorResponses = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((s) => [
      s,
      {
        description: { 400: "Bad request", 401: "Unauthenticated", 403: "Forbidden", 404: "Not found", 409: "Conflict", 413: "Payload too large", 415: "Unsupported media type", 422: "Validation error", 429: "Rate limited", 502: "Upstream failure", 503: "Service unavailable" }[s] ?? "Error",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    ]),
  );

export const SuccessSchema = z.object({ success: z.literal(true) });

interface RouteDoc {
  method: RouteConfig["method"];
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth?: boolean;
  body?: z.ZodType;
  /** multipart/form-data body instead of JSON (file fields: z.string().openapi({ type: "string", format: "binary" })). */
  multipart?: z.ZodObject;
  query?: z.ZodObject;
  params?: z.ZodObject;
  /** Payload inside `{ data }`; omit for `{ data: { success: true } }`. */
  response?: z.ZodType;
  status?: number;
  errors?: number[];
}

/** One-liner OpenAPI registration so route files stay readable. */
export function registerRoute(r: RouteDoc) {
  registry.registerPath({
    method: r.method,
    path: r.path,
    tags: [r.tag],
    summary: r.summary,
    description: r.description,
    security: r.auth ? [{ bearerAuth: [] }] : undefined,
    request: {
      body: r.body
        ? { required: true, content: { "application/json": { schema: r.body } } }
        : r.multipart
          ? { required: true, content: { "multipart/form-data": { schema: r.multipart } } }
          : undefined,
      query: r.query,
      params: r.params,
    },
    responses: {
      [r.status ?? 200]: {
        description: "Success",
        content: { "application/json": { schema: envelope(r.response ?? SuccessSchema) } },
      },
      ...errorResponses(...(r.errors ?? []), ...(r.auth ? [401] : []), 429),
    },
  });
}

/** Build lazily — after every module's schema file has registered its paths. */
export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "PlayerHaat API",
      version: "0.1.0",
      description:
        "Bangladesh-wide player discovery for local sports.\n\n" +
        "Success: `{ data, meta }`. Error: `{ error: { code, message, details } }` — the app translates `code`.\n" +
        "Money is whole BDT. Times are ISO-8601 UTC.",
    },
    servers: [{ url: `${env.PUBLIC_API_URL}${API_PREFIX}`, description: "API v1" }],
    tags: [{ name: "System" }, { name: "Auth" }, { name: "Reference" }, { name: "Users" }, { name: "Players" }, { name: "Media" }, { name: "Requests" }, { name: "Applications" }, { name: "Notifications" }, { name: "Ratings" }, { name: "Reports" }, { name: "Admin" }],
  });
}
