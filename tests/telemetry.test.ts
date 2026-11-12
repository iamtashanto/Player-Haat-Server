import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { purgeExpiredData } from "../src/modules/maintenance/purge-expired-data.js";
import { fingerprint, normalizeRoute, scrub } from "../src/modules/telemetry/telemetry.service.js";
import { V1, adminUser, api, prisma, resetDb, signedIn } from "./helpers.js";

beforeEach(resetDb);

const send = (body: object) => api().post(`${V1}/telemetry`).send(body);
const batch = (events: object[], over: object = {}) => ({ platform: "WEB", sessionId: "sess-abcdef12", appVersion: "1.0.0", locale: "bn", events, ...over });

describe("POST /telemetry", () => {
  it("accepts a batch anonymously, answers 200 and stores one row per event", async () => {
    const res = await send(batch([
      { kind: "EVENT", name: "signup_started", route: "/en/auth" },
      { kind: "ERROR", name: "window.onerror", message: "boom", stack: "Error: boom\n    at f (app.js:1:1)", route: "/bn/request/cmwabcdefghijklmnopqrs?x=1" },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(2);
    const rows = await prisma.telemetryEvent.findMany({ orderBy: { kind: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "ERROR", platform: "WEB", sessionId: "sess-abcdef12", locale: "bn", route: "/request/:id" });
    expect(rows[0]!.fingerprint).toHaveLength(16);
    expect(rows[1]).toMatchObject({ kind: "EVENT", name: "signup_started", route: "/auth", fingerprint: null });
  });

  it("keeps nothing that identifies a person: no account id column, and emails/phones/tokens are scrubbed", async () => {
    const u = await signedIn("someone@example.com");
    await api().post(`${V1}/telemetry`).set(u.auth).send(batch([
      { kind: "ERROR", name: "api_5xx", message: "Failed for someone@example.com phone 01712345678 Bearer abc.def.ghi token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", props: { who: "call 01812345678 or a@b.co", n: 3 } },
    ]));
    const row = await prisma.telemetryEvent.findFirstOrThrow();
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/someone@example\.com|01712345678|01812345678|a@b\.co|abc\.def\.ghi|eyJhbGci/);
    expect(row.message).toContain("[email]");
    expect(row.message).toContain("[phone]");
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["userId", "ip"])); // nothing to link it to an account or an address
    expect(text.includes(u.user.id)).toBe(false);
  });

  it("rejects anything outside the limits: too many events, bad names, bad session id, too many props", async () => {
    const ev = { kind: "EVENT", name: "ok_event" };
    expect((await send(batch(Array.from({ length: 21 }, () => ev)))).status).toBe(422);
    expect((await send(batch([]))).status).toBe(422);
    expect((await send(batch([{ kind: "EVENT", name: "has space" }]))).status).toBe(422);
    expect((await send(batch([ev], { sessionId: "x" }))).status).toBe(422);
    expect((await send(batch([ev], { platform: "TOASTER" }))).status).toBe(422);
    const props = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]));
    expect((await send(batch([{ ...ev, props }]))).status).toBe(422);
    expect(await prisma.telemetryEvent.count()).toBe(0);
  });

  it("can be switched off: it still answers 200 but accepts none", async () => {
    const was = env.TELEMETRY_ENABLED;
    (env as { TELEMETRY_ENABLED: boolean }).TELEMETRY_ENABLED = false;
    try {
      expect((await send(batch([{ kind: "EVENT", name: "signup_started" }]))).body.data.accepted).toBe(0);
      expect(await prisma.telemetryEvent.count()).toBe(0);
    } finally {
      (env as { TELEMETRY_ENABLED: boolean }).TELEMETRY_ENABLED = was;
    }
  });
});

describe("grouping", () => {
  it("the same error with different ids or numbers gets the same fingerprint; a different error does not", () => {
    const a = fingerprint("react", "Request cmwabcdefgh12345 failed after 3 tries", "Error\n    at load (page.js:10:5)");
    const b = fingerprint("react", "Request cmwzzzzzzzz99999 failed after 7 tries", "Error\n    at load (page.js:10:5)");
    const c = fingerprint("react", "Cannot read properties of undefined", "Error\n    at load (page.js:10:5)");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("routes lose the locale, the query and ids", () => {
    expect(normalizeRoute("/en/p/cmw8vb6un000hpjt7rkryxoi7?x=1#top")).toBe("/p/:id");
    expect(normalizeRoute("/bn/games/123/chat")).toBe("/games/:id/chat");
    expect(normalizeRoute(undefined)).toBeNull();
  });
  it("scrub leaves ordinary text alone", () => {
    expect(scrub("Network request failed at /api/v1/requests")).toBe("Network request failed at /api/v1/requests");
  });
});

describe("GET /admin/telemetry/summary", () => {
  it("is admin only", async () => {
    expect((await api().get(`${V1}/admin/telemetry/summary`)).status).toBe(401);
    const u = await signedIn("user@example.com");
    expect((await api().get(`${V1}/admin/telemetry/summary`).set(u.auth)).status).toBe(403);
  });

  it("groups errors by fingerprint across sessions, orders the funnel, and respects the date window", async () => {
    const admin = await adminUser();
    const crash = (sessionId: string, id: string, platform = "WEB") => send(batch([{ kind: "ERROR", name: "react", message: `Load ${id} failed`, stack: "Error\n    at load (page.js:1:1)", route: "/en/games" }], { sessionId, platform }));
    await crash("sessionaaaa1", "cmwabcdefgh11111");
    await crash("sessionaaaa1", "cmwabcdefgh22222");
    await crash("sessionbbbb2", "cmwabcdefgh33333", "ANDROID");
    for (const [sid, names] of [["sessionaaaa1", ["signup_started", "signup_completed", "request_posted"]], ["sessionbbbb2", ["signup_started"]]] as const) {
      await send(batch(names.map((name) => ({ kind: "EVENT", name })), { sessionId: sid }));
    }
    // an old crash outside the 7-day window
    await prisma.telemetryEvent.create({ data: { kind: "ERROR", name: "react", platform: "WEB", sessionId: "oldsession1", message: "Old failure", fingerprint: "oldoldoldoldold1", at: new Date(Date.now() - 20 * 86_400_000) } });

    const s = (await api().get(`${V1}/admin/telemetry/summary?days=7`).set(admin.auth)).body.data;
    expect(s.sessions).toBe(2);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toMatchObject({ name: "react", count: 3, sessions: 2 });
    expect([...s.errors[0].platforms].sort()).toEqual(["ANDROID", "WEB"]);
    expect(s.funnel.map((f: { name: string }) => f.name)).toEqual(["signup_started", "signup_completed", "request_posted"]);
    expect(s.funnel[0]).toMatchObject({ count: 2, sessions: 2 }); // two people started, one finished
    expect(s.funnel[1]).toMatchObject({ count: 1, sessions: 1 });
    const wide = (await api().get(`${V1}/admin/telemetry/summary?days=30`).set(admin.auth)).body.data;
    expect(wide.errors).toHaveLength(2);
    expect((await api().get(`${V1}/admin/telemetry/summary?days=5`).set(admin.auth)).status).toBe(422);
  });
});

describe("automated browsers", () => {
  it("reports tagged e2e never count in the admin numbers", async () => {
    const admin = await adminUser();
    await send(batch([{ kind: "EVENT", name: "signup_started" }, { kind: "ERROR", name: "react", message: "from a test run" }], { appVersion: "e2e", sessionId: "e2esession1" }));
    const s = (await api().get(`${V1}/admin/telemetry/summary`).set(admin.auth)).body.data;
    expect(s).toMatchObject({ sessions: 0, errors: [], funnel: [], platforms: [] });
  });
});

describe("retention", () => {
  it("deletes telemetry older than 90 days and keeps the rest", async () => {
    const old = new Date(Date.now() - 91 * 86_400_000);
    await prisma.telemetryEvent.createMany({ data: [
      { kind: "EVENT", name: "old", platform: "WEB", sessionId: "s1s1s1s1", at: old },
      { kind: "EVENT", name: "recent", platform: "WEB", sessionId: "s2s2s2s2", at: new Date(Date.now() - 5 * 86_400_000) },
    ] });
    const res = await purgeExpiredData();
    expect(res.telemetry).toBe(1);
    expect((await prisma.telemetryEvent.findMany()).map((e) => e.name)).toEqual(["recent"]);
  });
});
