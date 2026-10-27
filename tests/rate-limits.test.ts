import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signAccessToken } from "../src/lib/jwt.js";
import { createApiLimits, rateLimitControl } from "../src/middlewares/rate-limit.js";
import { DEFAULT_USER, V1, api, registerUser, resetDb, seedWorld, signedIn } from "./helpers.js";

// Limiters are off under NODE_ENV=test; this file turns them on.
beforeAll(() => {
  rateLimitControl.forceEnabled = true;
});
afterAll(() => {
  rateLimitControl.forceEnabled = false;
});


beforeEach(async () => {
  await resetDb();
  await seedWorld();
});

const loginAs = (email: string) => api().post(`${V1}/auth/login`).send({ email, password: "Wr0ngPassword1" });

describe("credential endpoints", () => {
  it("lets 10 failed logins through per IP+email, then answers 429 with the standard error and headers", async () => {
    await registerUser({ email: "target@example.com" });
    for (let i = 0; i < 10; i++) expect((await loginAs("target@example.com")).status).toBe(401);

    const blocked = await loginAs("target@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests, slow down." } });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["ratelimit"] ?? blocked.headers["ratelimit-policy"]).toBeTruthy();
  });

  it("keeps a separate bucket per target email, so locking one victim out doesn't touch anyone else", async () => {
    await registerUser({ email: "victim@example.com" });
    await registerUser({ email: "bystander@example.com" });
    for (let i = 0; i < 11; i++) await loginAs("victim@example.com");
    expect((await loginAs("victim@example.com")).status).toBe(429);

    const ok = await api().post(`${V1}/auth/login`).send({ email: "bystander@example.com", password: DEFAULT_USER.password });
    expect(ok.status).toBe(200);
  });

  it("the email bucket is case- and whitespace-insensitive (no dodging with 'A@x.com')", async () => {
    await registerUser({ email: "case@example.com" });
    for (let i = 0; i < 10; i++) await loginAs(i % 2 ? " CASE@example.com " : "case@example.com");
    expect((await loginAs("Case@Example.com")).status).toBe(429);
  });
});

describe("signed-in callers are counted per user, not per IP", () => {
  it("one user exhausting a route budget doesn't affect another user on the same IP", async () => {
    // POST /requests allows 20 per hour per user (invalid bodies still count).
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    for (let i = 0; i < 20; i++) expect((await api().post(`${V1}/requests`).set(a.auth).send({})).status).toBe(422);
    expect((await api().post(`${V1}/requests`).set(a.auth).send({})).status).toBe(429);
    expect((await api().post(`${V1}/requests`).set(b.auth).send({})).status).toBe(422); // same IP, different user
  });

  it("player search is capped at 60 a minute per user", async () => {
    const a = await signedIn("searcher@example.com");
    const b = await signedIn("other@example.com");
    for (let i = 0; i < 60; i++) expect((await api().get(`${V1}/players`).set(a.auth)).status).toBe(200);
    expect((await api().get(`${V1}/players`).set(a.auth)).status).toBe(429);
    expect((await api().get(`${V1}/players`).set(b.auth)).status).toBe(200);
  });

  it("the public location search is capped per IP (60 a minute)", async () => {
    for (let i = 0; i < 60; i++) expect((await api().get(`${V1}/locations/search?q=ka`)).status).toBe(200);
    const blocked = await api().get(`${V1}/locations/search?q=ka`);
    expect(blocked.status).toBe(429);
    expect((await api().get(`${V1}/locations/divisions`)).status).toBe(200); // other endpoints unaffected
  });
});

describe("blanket API limits (tiny budgets on a throwaway app)", () => {
  const mini = (limits: { ip: number; reads: number; writes: number }) => {
    const app = express();
    app.use(express.json());
    app.use(createApiLimits({ ipPer15Min: limits.ip, callerReadsPer15Min: limits.reads, callerWritesPer15Min: limits.writes }));
    app.all("/ping", (_req, res) => res.json({ ok: true }));
    return app;
  };
  const token = (userId: string) => signAccessToken({ userId, role: "PLAYER" });

  it("anonymous callers are limited per IP", async () => {
    const app = mini({ ip: 5, reads: 100, writes: 100 });
    for (let i = 0; i < 5; i++) expect((await request(app).get("/ping")).status).toBe(200);
    expect((await request(app).get("/ping")).status).toBe(429);
  });

  it("signed-in callers get their own read and write budgets, counted separately", async () => {
    const app = mini({ ip: 1000, reads: 3, writes: 2 });
    const t = await token("user-1");
    const h = { Authorization: `Bearer ${t}` };
    for (let i = 0; i < 3; i++) expect((await request(app).get("/ping").set(h)).status).toBe(200);
    expect((await request(app).get("/ping").set(h)).status).toBe(429);
    for (let i = 0; i < 2; i++) expect((await request(app).post("/ping").set(h).send({})).status).toBe(200); // writes unaffected by reads
    expect((await request(app).post("/ping").set(h).send({})).status).toBe(429);
  });

  it("users don't share budgets with each other or with anonymous traffic", async () => {
    const app = mini({ ip: 1000, reads: 2, writes: 2 });
    const h1 = { Authorization: `Bearer ${await token("user-1")}` };
    const h2 = { Authorization: `Bearer ${await token("user-2")}` };
    for (let i = 0; i < 3; i++) await request(app).get("/ping").set(h1);
    expect((await request(app).get("/ping").set(h1)).status).toBe(429);
    expect((await request(app).get("/ping").set(h2)).status).toBe(200);
    expect((await request(app).get("/ping")).status).toBe(200); // anonymous isn't charged to the user buckets
  });

  it("the per-IP ceiling still applies across users (a bot farm on one address)", async () => {
    const app = mini({ ip: 5, reads: 100, writes: 100 });
    const h1 = { Authorization: `Bearer ${await token("user-1")}` };
    const h2 = { Authorization: `Bearer ${await token("user-2")}` };
    for (let i = 0; i < 3; i++) await request(app).get("/ping").set(h1);
    for (let i = 0; i < 2; i++) await request(app).get("/ping").set(h2);
    expect((await request(app).get("/ping").set(h2)).status).toBe(429);
  });

  it("a forged, expired or garbage token is just an anonymous caller — it can't pick (or dodge) a bucket", async () => {
    const app = mini({ ip: 1000, reads: 1, writes: 1 });
    // Garbage tokens are charged to the IP (which is generous here), never to a user bucket.
    for (let i = 0; i < 5; i++) expect((await request(app).get("/ping").set({ Authorization: "Bearer not.a.jwt" })).status).toBe(200);
    const real = { Authorization: `Bearer ${await token("user-1")}` };
    expect((await request(app).get("/ping").set(real)).status).toBe(200); // the real user's bucket is untouched
  });
});

describe("limits never apply while disabled", () => {
  it("is a no-op when the control flag is off (the state every other test file runs in)", async () => {
    rateLimitControl.forceEnabled = false;
    await registerUser({ email: "free@example.com" });
    for (let i = 0; i < 15; i++) expect((await loginAs("free@example.com")).status).toBe(401);
    rateLimitControl.forceEnabled = true;
  });
});

