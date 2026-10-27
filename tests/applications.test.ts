import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const post = (a: Auth, path: string, body?: object) => api().post(`${V1}${path}`).set(a).send(body);
const get = (a: Auth, path: string, query: Record<string, string | number> = {}) => api().get(`${V1}${path}`).set(a).query(query);
const apply = (a: Auth, requestId: string, body: object = {}) => post(a, `/requests/${requestId}/applications`, body);
const football = () => [{ sportId: w.football.id, positions: ["GK"] }];

async function scene(requestOver: Parameters<typeof makeRequest>[2] = {}) {
  const cap = await signedIn("cap@example.com");
  const request = await makeRequest(w, cap.user.id, requestOver);
  const player = await playerUser(w, "player@example.com", football());
  return { cap, request, player };
}

describe("apply", () => {
  it("creates a PENDING application, returns the applicant card, and notifies the poster", async () => {
    const { cap, request, player } = await scene({ isPaid: true, budgetMin: 300, budgetMax: 500 });
    const res = await apply(player.auth, request.id, { proposedRate: 450, message: "  I can keep goal  " });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "PENDING", proposedRate: 450, message: "I can keep goal", respondedAt: null });
    expect(res.body.data.player).toMatchObject({ name: "Viewer", sports: [{ sportCode: "FOOTBALL" }] });
    expect(res.body.data).not.toHaveProperty("contact");

    await settle();
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: cap.user.id } });
    expect(n).toMatchObject({ type: "NEW_APPLICANT" });
    expect(n.data).toMatchObject({ requestId: request.id, applicationId: res.body.data.id, actor: "Viewer" });
  });

  it("works without a rate or message", async () => {
    const { request, player } = await scene();
    expect((await apply(player.auth, request.id)).status).toBe(201);
  });

  it("needs a player profile, and the request's sport on it", async () => {
    const { request } = await scene();
    const noProfile = await signedIn("noprofile@example.com");
    const a = await apply(noProfile.auth, request.id);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("PLAYER_PROFILE_REQUIRED");

    const cricketer = await playerUser(w, "cricket@example.com", [{ sportId: w.cricket.id }]);
    const b = await apply(cricketer.auth, request.id);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PLAYER_SPORT_REQUIRED");
  });

  it("can't apply to my own request", async () => {
    const cap = await playerUser(w, "cap2@example.com", football());
    const own = await makeRequest(w, cap.user.id);
    const res = await apply(cap.auth, own.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REQUEST_OWN");
  });

  it.each([
    ["filled", { status: "FILLED" as const }, "REQUEST_FILLED"],
    ["cancelled", { status: "CANCELLED" as const }, "REQUEST_NOT_OPEN"],
    ["completed", { status: "COMPLETED" as const }, "REQUEST_NOT_OPEN"],
    ["already started", { matchAt: hoursFromNow(-1) }, "REQUEST_EXPIRED"],
  ])("refuses a %s request", async (_label, over, code) => {
    const { request, player } = await scene(over);
    const res = await apply(player.auth, request.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
    expect(await prisma.application.count()).toBe(0);
  });

  it("treats hidden requests and suspended posters as not found", async () => {
    const { cap, request, player } = await scene({ isHidden: true });
    expect((await apply(player.auth, request.id)).status).toBe(404);
    await prisma.playerRequest.update({ where: { id: request.id }, data: { isHidden: false } });
    await prisma.user.update({ where: { id: cap.user.id }, data: { status: "SUSPENDED" } });
    expect((await apply(player.auth, request.id)).status).toBe(404);
    expect((await apply(player.auth, "nope")).body.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("only allows a proposed rate on paid requests, and not a negative one", async () => {
    const free = await scene();
    expect((await apply(free.player.auth, free.request.id, { proposedRate: 300 })).status).toBe(422);
    const paid = await makeRequest(w, free.cap.user.id, { isPaid: true });
    expect((await apply(free.player.auth, paid.id, { proposedRate: -5 })).status).toBe(422);
    expect((await apply(free.player.auth, paid.id, { proposedRate: 300 })).status).toBe(201);
  });

  it("rejects unknown body fields (no setting status)", async () => {
    const { request, player } = await scene();
    expect((await apply(player.auth, request.id, { status: "ACCEPTED" })).status).toBe(422);
  });

  it("refuses a duplicate while pending/accepted/rejected, but lets a withdrawn one re-apply on the same row", async () => {
    const { request, player } = await scene();
    const first = await apply(player.auth, request.id, { message: "one" });
    expect((await apply(player.auth, request.id)).body.error.code).toBe("APPLICATION_EXISTS");

    await post(player.auth, `/applications/${first.body.data.id}/withdraw`);
    const again = await apply(player.auth, request.id, { message: "two" });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, status: "PENDING", message: "two" });
    expect(await prisma.application.count()).toBe(1);

    await prisma.application.update({ where: { id: first.body.data.id }, data: { status: "REJECTED" } });
    expect((await apply(player.auth, request.id)).body.error.code).toBe("APPLICATION_EXISTS");
  });

  it("two simultaneous applications from one player leave exactly one row", async () => {
    const { request, player } = await scene();
    const results = await Promise.all([apply(player.auth, request.id), apply(player.auth, request.id), apply(player.auth, request.id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.application.count()).toBe(1);
  });
});

describe("applicants list (poster only)", () => {
  it("lists applicants oldest first with cards; only the poster can see them", async () => {
    const { cap, request } = await scene();
    const p1 = await playerUser(w, "p1@example.com", football());
    const p2 = await playerUser(w, "p2@example.com", football());
    const a1 = await makeApplication(request.id, p1.user.id);
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await makeApplication(request.id, p2.user.id, "REJECTED");

    const res = await get(cap.auth, `/requests/${request.id}/applications`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { id: string }) => a.id)).toEqual([a1.id, a2.id]);
    expect(res.body.data[0].player).toMatchObject({ name: "Viewer", sports: [{ sportCode: "FOOTBALL" }] });
    expect((await get(cap.auth, `/requests/${request.id}/applications`, { status: "REJECTED" })).body.data).toHaveLength(1);

    const stranger = await signedIn("stranger@example.com");
    const denied = await get(stranger.auth, `/requests/${request.id}/applications`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("REQUEST_NOT_OWNER");
    expect((await get(cap.auth, `/requests/nope/applications`)).status).toBe(404);
  });

  it("never exposes a pending applicant's email or phone", async () => {
    const { cap, request } = await scene();
    const p = await playerUser(w, "secret@example.com", football());
    await prisma.user.update({ where: { id: p.user.id }, data: { phone: "+8801712345678" } });
    await makeApplication(request.id, p.user.id);
    const raw = JSON.stringify((await get(cap.auth, `/requests/${request.id}/applications`)).body);
    expect(raw).not.toMatch(/secret@example|8801712345678|contact/);
  });

  it("paginates applicants", async () => {
    const { cap, request } = await scene();
    for (let i = 0; i < 5; i++) {
      const p = await playerUser(w, `bulk${i}@example.com`, football());
      await makeApplication(request.id, p.user.id);
    }
    const first = await get(cap.auth, `/requests/${request.id}/applications`, { limit: 2 });
    const second = await get(cap.auth, `/requests/${request.id}/applications`, { limit: 2, cursor: first.body.meta.nextCursor });
    const third = await get(cap.auth, `/requests/${request.id}/applications`, { limit: 2, cursor: second.body.meta.nextCursor });
    const all = [...first.body.data, ...second.body.data, ...third.body.data].map((a: { id: string }) => a.id);
    expect(new Set(all).size).toBe(5);
    expect(third.body.meta.nextCursor).toBeNull();
  });
});

describe("accept", () => {
  it("accepts, increments the count, notifies the player — and fills the request at playersNeeded", async () => {
    const { cap, request, player } = await scene({ playersNeeded: 2 });
    const p2 = await playerUser(w, "p2@example.com", football());
    const a1 = await makeApplication(request.id, player.user.id);
    const a2 = await makeApplication(request.id, p2.user.id);

    const one = await post(cap.auth, `/applications/${a1.id}/accept`);
    expect(one.status).toBe(200);
    expect(one.body.data.status).toBe("ACCEPTED");
    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ playersAccepted: 1, status: "OPEN" });

    await post(cap.auth, `/applications/${a2.id}/accept`);
    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ playersAccepted: 2, status: "FILLED" });

    await settle();
    const notified = await prisma.notification.findMany({ where: { type: "APPLICATION_ACCEPTED" } });
    expect(notified.map((n) => n.userId).sort()).toEqual([player.user.id, p2.user.id].sort());
  });

  it("can't over-fill: accepting beyond playersNeeded fails with REQUEST_FILLED", async () => {
    const { cap, request, player } = await scene({ playersNeeded: 1 });
    const other = await playerUser(w, "other@example.com", football());
    const a1 = await makeApplication(request.id, player.user.id);
    const a2 = await makeApplication(request.id, other.user.id);
    await post(cap.auth, `/applications/${a1.id}/accept`);
    const res = await post(cap.auth, `/applications/${a2.id}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_FILLED");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe("PENDING");
  });

  it("is atomic under concurrency: six simultaneous accepts for three spots → exactly three accepted", async () => {
    const { cap, request } = await scene({ playersNeeded: 3 });
    const apps = [];
    for (let i = 0; i < 6; i++) {
      const p = await playerUser(w, `race${i}@example.com`, football());
      apps.push(await makeApplication(request.id, p.user.id));
    }
    const results = await Promise.all(apps.map((a) => post(cap.auth, `/applications/${a.id}/accept`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "REQUEST_FILLED")).toBe(true);

    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ playersAccepted: 3, status: "FILLED" });
    expect(await prisma.application.count({ where: { status: "ACCEPTED" } })).toBe(3);
  });

  it("is idempotent for an already accepted application (no double count, no second push)", async () => {
    const { cap, request, player } = await scene({ playersNeeded: 3 });
    const a = await makeApplication(request.id, player.user.id);
    await post(cap.auth, `/applications/${a.id}/accept`);
    await settle();
    const again = await post(cap.auth, `/applications/${a.id}/accept`);
    await settle();
    expect(again.status).toBe(200);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).playersAccepted).toBe(1);
    expect(await prisma.notification.count({ where: { type: "APPLICATION_ACCEPTED" } })).toBe(1);
  });

  it("only accepts PENDING applications", async () => {
    const { cap, request, player } = await scene();
    const rejected = await makeApplication(request.id, player.user.id, "REJECTED");
    const res = await post(cap.auth, `/applications/${rejected.id}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPLICATION_NOT_PENDING");

    const other = await playerUser(w, "o@example.com", football());
    const withdrawn = await makeApplication(request.id, other.user.id, "WITHDRAWN");
    expect((await post(cap.auth, `/applications/${withdrawn.id}/accept`)).body.error.code).toBe("APPLICATION_NOT_PENDING");
  });

  it("refuses on cancelled, completed and already-started matches", async () => {
    for (const [over, code] of [
      [{ status: "CANCELLED" as const }, "REQUEST_NOT_OPEN"],
      [{ status: "COMPLETED" as const }, "REQUEST_NOT_OPEN"],
      [{ matchAt: hoursFromNow(-2) }, "REQUEST_EXPIRED"],
    ] as const) {
      await resetDb();
      w = await seedWorld();
      const { cap, request, player } = await scene(over);
      const a = await makeApplication(request.id, player.user.id);
      const res = await post(cap.auth, `/applications/${a.id}/accept`);
      expect(res.body.error.code).toBe(code);
      expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).playersAccepted).toBe(0);
    }
  });

  it("is poster-only: others get 403, unknown ids 404", async () => {
    const { request, player } = await scene();
    const a = await makeApplication(request.id, player.user.id);
    const res = await post(player.auth, `/applications/${a.id}/accept`); // the applicant can't accept themselves
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REQUEST_NOT_OWNER");
    expect((await post(player.auth, `/applications/nope/accept`)).body.error.code).toBe("APPLICATION_NOT_FOUND");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PENDING");
  });

  it("reveals phones to both sides only after acceptance", async () => {
    const { cap, request, player } = await scene();
    await prisma.user.update({ where: { id: cap.user.id }, data: { phone: "+8801811111111" } });
    await prisma.user.update({ where: { id: player.user.id }, data: { phone: "+8801922222222" } });
    const a = await makeApplication(request.id, player.user.id);

    const before = JSON.stringify((await get(player.auth, "/applications/mine")).body);
    expect(before).not.toMatch(/8801811111111|contact/);

    const accepted = await post(cap.auth, `/applications/${a.id}/accept`);
    expect(accepted.body.data.contact).toEqual({ phone: "+8801922222222" }); // poster sees the player's number
    const mine = await get(player.auth, "/applications/mine");
    expect(mine.body.data[0].contact).toEqual({ phone: "+8801811111111" }); // player sees the poster's number
    expect(JSON.stringify(mine.body)).not.toContain("createdById");
  });
});

describe("reject", () => {
  it("rejects a pending applicant, notifies them, and is idempotent", async () => {
    const { cap, request, player } = await scene();
    const a = await makeApplication(request.id, player.user.id);
    const res = await post(cap.auth, `/applications/${a.id}/reject`);
    expect(res.body.data).toMatchObject({ status: "REJECTED" });
    expect(res.body.data.respondedAt).toBeTruthy();
    await settle();
    expect(await prisma.notification.count({ where: { userId: player.user.id, type: "APPLICATION_REJECTED" } })).toBe(1);

    await post(cap.auth, `/applications/${a.id}/reject`);
    await settle();
    expect(await prisma.notification.count({ where: { type: "APPLICATION_REJECTED" } })).toBe(1);
  });

  it("can clear the queue on a FILLED request, but won't reject an accepted player", async () => {
    const { cap, request, player } = await scene({ status: "FILLED", playersNeeded: 1, playersAccepted: 1 });
    const other = await playerUser(w, "o@example.com", football());
    const pending = await makeApplication(request.id, other.user.id);
    const accepted = await makeApplication(request.id, player.user.id, "ACCEPTED");
    expect((await post(cap.auth, `/applications/${pending.id}/reject`)).status).toBe(200);
    expect((await post(cap.auth, `/applications/${accepted.id}/reject`)).body.error.code).toBe("APPLICATION_NOT_PENDING");
  });

  it("is poster-only", async () => {
    const { request, player } = await scene();
    const a = await makeApplication(request.id, player.user.id);
    expect((await post(player.auth, `/applications/${a.id}/reject`)).status).toBe(403);
  });
});

describe("withdraw", () => {
  it("lets a player withdraw a pending application without bothering the poster", async () => {
    const { cap, request, player } = await scene();
    const a = await makeApplication(request.id, player.user.id);
    const res = await post(player.auth, `/applications/${a.id}/withdraw`);
    expect(res.body.data.status).toBe("WITHDRAWN");
    await settle();
    expect(await prisma.notification.count({ where: { userId: cap.user.id } })).toBe(0);
  });

  it("withdrawing after acceptance frees the spot, re-opens a FILLED request, and notifies the poster", async () => {
    const { cap, request, player } = await scene({ playersNeeded: 1 });
    const a = await makeApplication(request.id, player.user.id);
    await post(cap.auth, `/applications/${a.id}/accept`);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("FILLED");

    const res = await post(player.auth, `/applications/${a.id}/withdraw`);
    expect(res.status).toBe(200);
    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "OPEN", playersAccepted: 0 });

    await settle();
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: cap.user.id, type: "APPLICATION_WITHDRAWN" } });
    expect(n.data).toMatchObject({ requestId: request.id, actor: "Viewer" });

    // …and the freed spot can be taken by someone else.
    const next = await playerUser(w, "next@example.com", football());
    const nextApp = await apply(next.auth, request.id);
    expect(nextApp.status).toBe(201);
    expect((await post(cap.auth, `/applications/${nextApp.body.data.id}/accept`)).status).toBe(200);
  });

  it("is idempotent, owner-only, and refused for rejected applications and finished requests", async () => {
    const { cap, request, player } = await scene();
    const a = await makeApplication(request.id, player.user.id);
    expect((await post(cap.auth, `/applications/${a.id}/withdraw`)).status).toBe(404); // poster isn't the applicant
    await post(player.auth, `/applications/${a.id}/withdraw`);
    expect((await post(player.auth, `/applications/${a.id}/withdraw`)).status).toBe(200);

    const other = await playerUser(w, "o@example.com", football());
    const rej = await makeApplication(request.id, other.user.id, "REJECTED");
    expect((await post(other.auth, `/applications/${rej.id}/withdraw`)).body.error.code).toBe("APPLICATION_NOT_PENDING");

    const done = await makeRequest(w, cap.user.id, { status: "COMPLETED", matchAt: hoursFromNow(-3), playersAccepted: 1 });
    const acc = await makeApplication(done.id, player.user.id, "ACCEPTED");
    expect((await post(player.auth, `/applications/${acc.id}/withdraw`)).body.error.code).toBe("REQUEST_CLOSED");
  });
});

describe("GET /applications/mine", () => {
  it("lists my applications newest first with the request attached, filtered by status", async () => {
    const cap = await signedIn("cap@example.com");
    const player = await playerUser(w, "player@example.com", football());
    const r1 = await makeRequest(w, cap.user.id, { venueText: "First" });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await makeRequest(w, cap.user.id, { venueText: "Second" });
    await makeApplication(r1.id, player.user.id, "PENDING");
    await new Promise((r) => setTimeout(r, 5));
    await makeApplication(r2.id, player.user.id, "REJECTED");
    await makeApplication(r2.id, (await playerUser(w, "x@example.com", football())).user.id); // someone else's

    const res = await get(player.auth, "/applications/mine");
    expect(res.body.data.map((a: { request: { venueText: string } }) => a.request.venueText)).toEqual(["Second", "First"]);
    expect(res.body.data[0].request).toMatchObject({ sport: { code: "FOOTBALL" }, captain: { name: "Viewer" }, isOwner: false });
    expect((await get(player.auth, "/applications/mine", { status: "PENDING" })).body.data).toHaveLength(1);
    expect((await get(player.auth, "/applications/mine", { status: "NOPE" })).status).toBe(422);
    expect((await api().get(`${V1}/applications/mine`)).status).toBe(401);
  });
});
