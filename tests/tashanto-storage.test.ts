import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "./images.js";
const png = () => PNG;

// The provider under test is imported directly: setup.ts mocks only `storage/index.js`.
vi.mock("../src/config/env.js", async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { ...mod, env: new Proxy(mod.env, { get: (t, k) => (k === "MEDIA_BASE_URL" ? process.env.TEST_MEDIA_URL : k === "MEDIA_API_KEY" ? "mk_test_secret" : t[k as string]) }) };
});
const { TashantoMediaStorage } = await import("../src/lib/storage/tashanto.js");

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
let handler: Handler;
let calls: Array<{ method: string; url: string; auth?: string; body: string }> = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: body.toString("latin1") });
    handler(req, res, body);
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.TEST_MEDIA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { calls = []; });

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const KEY = "playerhaat/test/avatars/user1/abc";
const file = (over: Record<string, unknown> = {}) => ({ id: "F1", path: `${KEY}-x9y8z7.jpg`, width: 512, height: 512, size: 1234, created_at: "2026-01-01 00:00:00", ...over });
const store = () => new TashantoMediaStorage();

describe("TashantoMediaStorage", () => {
  it("uploads with the bearer key, sends the folder without the project prefix, and returns the service's path as the id", async () => {
    handler = (_q, res) => json(res, 201, file());
    const out = await store().uploadImage(png(), { kind: "avatar", publicId: KEY });
    expect(out.publicId).toBe(`${KEY}-x9y8z7.jpg`);
    expect(out.url).toMatch(/\/img\/-\/playerhaat\/test\/avatars\/user1\/abc-x9y8z7\.jpg$/);
    expect(out).toMatchObject({ width: 512, height: 512, bytes: 1234 });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/v1/upload", auth: "Bearer mk_test_secret" });
    expect(calls[0]!.body).toContain('name="folder"');
    expect(calls[0]!.body).toContain("test/avatars/user1");
    expect(calls[0]!.body).not.toContain("playerhaat/test/avatars");
  });

  it("rejects bytes that are not an image without calling the service", async () => {
    handler = (_q, res) => json(res, 201, file());
    await expect(store().uploadImage(Buffer.from("not an image at all"), { kind: "avatar", publicId: KEY })).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("retries once on 429 and succeeds", async () => {
    let n = 0;
    handler = (_q, res) => (++n === 1 ? json(res, 429, { error: "slow down" }, { "retry-after": "0" }) : json(res, 201, file()));
    const out = await store().uploadImage(png(), { kind: "avatar", publicId: KEY });
    expect(out.publicId).toContain("x9y8z7");
    expect(calls).toHaveLength(2);
  });

  it("gives up after one retry on a 5xx and maps every service error to STORAGE_UPLOAD_FAILED (no leak of the service's message)", async () => {
    handler = (_q, res) => json(res, 503, { error: "upstream secret detail" });
    await expect(store().uploadImage(png(), { kind: "avatar", publicId: KEY })).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 502 });
    expect(calls).toHaveLength(2);
    for (const status of [400, 401, 403, 413, 415, 422]) {
      calls = [];
      handler = (_q, res) => json(res, status, { error: "nope" });
      await expect(store().uploadImage(png(), { kind: "avatar", publicId: KEY })).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED" });
      expect(calls).toHaveLength(1); // 4xx is final, no retry
    }
  });

  it("deletes by looking the file up in its folder first; a missing file is fine", async () => {
    handler = (req, res) => (req.method === "GET" ? json(res, 200, { count: 1, files: [file()] }) : json(res, 200, { deleted: true }));
    await store().deleteImage(`${KEY}-x9y8z7.jpg`);
    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /api/v1/files", "DELETE /api/v1/files/F1"]);
    calls = [];
    handler = (_q, res) => json(res, 200, { count: 0, files: [] });
    await store().deleteImage(`${KEY}-gone.jpg`);
    expect(calls).toHaveLength(1);
  });

  it("lists only files older than the cutoff, reading the service's UTC timestamps", async () => {
    handler = (_q, res) => json(res, 200, { count: 2, files: [file({ id: "A", path: "playerhaat/test/a.jpg", created_at: "2026-01-01 00:00:00" }), file({ id: "B", path: "playerhaat/test/b.jpg", created_at: "2026-06-01 00:00:00" })] });
    const out = await store().listImages({ prefix: "playerhaat/test/", olderThan: new Date("2026-03-01T00:00:00Z"), limit: 10 });
    expect(out.map((o) => o.publicId)).toEqual(["playerhaat/test/a.jpg"]);
  });

  it("never puts the key in an error or a log line", async () => {
    handler = (_q, res) => json(res, 500, { error: "boom" });
    const err = await store().uploadImage(png(), { kind: "avatar", publicId: KEY }).catch((e) => e);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("mk_test_secret");
  });
});
