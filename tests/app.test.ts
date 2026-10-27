import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({ prisma: { $queryRaw: queryRaw } }));

const { createApp } = await import("../src/app.js");
const { validate } = await import("../src/middlewares/validate.js");
const { errorHandler } = await import("../src/middlewares/error-handler.js");
const { AppError } = await import("../src/lib/errors.js");
const { z } = await import("zod");

describe("health", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("GET /health is a DB-free liveness probe", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("GET /health/ready returns 200 when the DB answers", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await request(createApp()).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.data.db.ok).toBe(true);
  });

  it("GET /health/ready returns 503 SERVICE_UNAVAILABLE when the DB is down", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await request(createApp()).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("app plumbing", () => {
  it("sets a request id and echoes a client-provided one", async () => {
    const generated = await request(createApp()).get("/health");
    expect(generated.headers["x-request-id"]).toBeTruthy();

    const echoed = await request(createApp()).get("/health").set("X-Request-Id", "abc-123");
    expect(echoed.headers["x-request-id"]).toBe("abc-123");
  });

  it("returns a ROUTE_NOT_FOUND error envelope for unknown routes", async () => {
    const res = await request(createApp()).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("returns MALFORMED_JSON for a broken body", async () => {
    const res = await request(createApp())
      .post("/api/v1/anything")
      .set("Content-Type", "application/json")
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });

  it("rejects bodies over the size limit with PAYLOAD_TOO_LARGE", async () => {
    const res = await request(createApp())
      .post("/api/v1/anything")
      .send({ blob: "x".repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("serves the OpenAPI document including /health", async () => {
    const res = await request(createApp()).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/health"]).toBeDefined();
  });

  it("survives repeated query params (hpp) on Express 5", async () => {
    const res = await request(createApp()).get("/health?a=1&a=2");
    expect(res.status).toBe(200);
  });
});

describe("validate + error handler", () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/t/:id",
    validate({
      params: z.object({ id: z.string().min(3) }),
      query: z.object({ n: z.coerce.number().int().default(1) }),
      body: z.object({ name: z.string().min(1) }),
    }),
    (req, res) => res.json(req.valid),
  );
  app.get("/boom", () => {
    throw new Error("secret internals");
  });
  app.get("/app-error", () => {
    throw new AppError("REQUEST_NOT_OPEN", 409, "closed");
  });
  app.use(errorHandler);

  it("passes parsed (coerced, defaulted) values to the handler", async () => {
    const res = await request(app).post("/t/abc?n=5").send({ name: "x" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { name: "x" }, params: { id: "abc" }, query: { n: 5 } });
  });

  it("maps ZodError to 422 VALIDATION_ERROR with per-field details", async () => {
    const res = await request(app).post("/t/ab").send({ name: "" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it("maps AppError to its status and stable code", async () => {
    const res = await request(app).get("/app-error");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "REQUEST_NOT_OPEN", message: "closed" });
  });

  it("hides internals of unexpected errors behind INTERNAL_ERROR", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).toBe("Internal server error");
  });
});
