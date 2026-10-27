import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, requestBody, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const post = (a: Auth, path: string, body?: object) => api().post(`${V1}${path}`).set(a).send(body);
const patch = (a: Auth, path: string, body: object) => api().patch(`${V1}${path}`).set(a).send(body);
const get = (a: Auth, path: string, query: Record<string, string | number | boolean> = {}) => api().get(`${V1}${path}`).set(a).query(query);

describe("POST /requests", () => {
  it("creates an OPEN request and returns the poster's view without leaking the poster's id", async () => {
    const { auth } = await signedIn("cap@example.com");
    const res = await post(auth, "/requests", requestBody(w, { unionId: w.latachapli.id, notes: " Bring boots ", isPaid: true, budgetMin: 300, budgetMax: 500 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "OPEN",
      sport: { code: "FOOTBALL" },
      venueText: "Kuakata Sea Beach Ground",
      location: { district: { nameEn: "Patuakhali" }, upazila: { nameEn: "Kalapara" }, union: { nameEn: "Latachapli" } },
      positionsNeeded: ["GK"],
      playersNeeded: 2,
      playersAccepted: 0,
      spotsLeft: 2,
      isPaid: true,
      budgetMin: 300,
      budgetMax: 500,
      notes: "Bring boots",
      captain: { name: "Viewer", rating: { average: 0, count: 0 } },
      isOwner: true,
      myApplication: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/createdById|cap@example/);
  });

  it("defaults: one player, free, any position; dedupes positions", async () => {
    const { auth } = await signedIn();
    const res = await post(auth, "/requests", requestBody(w, { playersNeeded: undefined, positionsNeeded: ["GK", "GK", "ST"] }));
    expect(res.body.data).toMatchObject({ playersNeeded: 1, isPaid: false, positionsNeeded: ["GK", "ST"] });
    const any = await post(auth, "/requests", requestBody(w, { positionsNeeded: [] }));
    expect(any.body.data.positionsNeeded).toEqual([]);
  });

  it.each([
    ["a past time", { matchAt: new Date(Date.now() - 60_000).toISOString() }],
    ["more than 120 days ahead", { matchAt: new Date(Date.now() + 121 * 86_400_000).toISOString() }],
    ["a non-ISO time", { matchAt: "tomorrow 5pm" }],
    ["an unknown position", { positionsNeeded: ["GOALIE"] }],
    ["another sport's position", { positionsNeeded: ["BATTER"] }],
    ["too many positions", { positionsNeeded: ["a", "b", "c", "d", "e", "f", "g"] }],
    ["a budget on a free request", { isPaid: false, budgetMin: 100 }],
    ["an inverted budget", { isPaid: true, budgetMin: 500, budgetMax: 100 }],
    ["zero players", { playersNeeded: 0 }],
    ["31 players", { playersNeeded: 31 }],
    ["an empty venue", { venueText: "   " }],
    ["a client-set status", { status: "FILLED" }],
    ["a client-set accepted count", { playersAccepted: 5 }],
    ["a client-set owner", { createdById: "someone" }],
    ["an inactive sport", { sportId: 3, positionsNeeded: [] }],
    ["an unknown sport", { sportId: 999_999, positionsNeeded: [] }],
  ])("rejects %s", async (_label, over) => {
    const { auth } = await signedIn();
    const body = requestBody(w, over);
    if ((over as { sportId?: number }).sportId === 3) body.sportId = w.badminton.id;
    const res = await post(auth, "/requests", body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.playerRequest.count()).toBe(0);
  });

  it("rejects a mismatched location with LOCATION_INVALID", async () => {
    const { auth } = await signedIn();
    const res = await post(auth, "/requests", requestBody(w, { districtId: w.dhaka.id }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LOCATION_INVALID");
  });

  it("only lets me post for a team I captain, of the same sport", async () => {
    const me = await signedIn("me@example.com");
    const other = await signedIn("other@example.com");
    const base = { sportId: w.football.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id };
    const mine = await prisma.team.create({ data: { name: "Kuakata FC", captainId: me.user.id, ...base } });
    const theirs = await prisma.team.create({ data: { name: "Other FC", captainId: other.user.id, ...base } });
    const cricketTeam = await prisma.team.create({ data: { name: "Bats", captainId: me.user.id, ...base, sportId: w.cricket.id } });

    const ok = await post(me.auth, "/requests", requestBody(w, { teamId: mine.id }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.team).toMatchObject({ id: mine.id, name: "Kuakata FC" });
    expect((await post(me.auth, "/requests", requestBody(w, { teamId: theirs.id }))).status).toBe(422);
    expect((await post(me.auth, "/requests", requestBody(w, { teamId: cricketTeam.id }))).status).toBe(422);
    expect((await post(me.auth, "/requests", requestBody(w, { teamId: "nope" }))).status).toBe(422);
  });

  it("caps active upcoming requests at 10; finished and past ones don't count", async () => {
    const { auth, user } = await signedIn();
    for (let i = 0; i < 8; i++) await makeRequest(w, user.id);
    await makeRequest(w, user.id, { status: "CANCELLED" });
    await makeRequest(w, user.id, { status: "COMPLETED", matchAt: hoursFromNow(-5) });
    await makeRequest(w, user.id, { matchAt: hoursFromNow(-5) });
    expect((await post(auth, "/requests", requestBody(w))).status).toBe(201); // 9th active
    expect((await post(auth, "/requests", requestBody(w))).status).toBe(201); // 10th
    const res = await post(auth, "/requests", requestBody(w));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_LIMIT");
  });

  it("requires authentication", async () => {
    expect((await api().post(`${V1}/requests`).send(requestBody(w))).status).toBe(401);
  });
});

describe("PATCH /requests/:id", () => {
  const setup = async () => {
    const cap = await signedIn("cap@example.com");
    const created = await post(cap.auth, "/requests", requestBody(w, { playersNeeded: 3 }));
    return { cap, id: created.body.data.id as string, userId: cap.user.id };
  };

  it("edits venue, notes, time, positions and budget", async () => {
    const { cap, id } = await setup();
    const matchAt = hoursFromNow(72).toISOString();
    const res = await patch(cap.auth, `/requests/${id}`, { venueText: "Mohipur Field", notes: "Late kickoff", matchAt, positionsNeeded: ["ST"], isPaid: true, budgetMin: 200, budgetMax: 400 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ venueText: "Mohipur Field", notes: "Late kickoff", positionsNeeded: ["ST"], isPaid: true, budgetMin: 200, budgetMax: 400 });
    expect(new Date(res.body.data.matchAt).toISOString()).toBe(matchAt);
  });

  it("can't change sport or location (cancel and repost instead), or protected fields", async () => {
    const { cap, id } = await setup();
    for (const body of [{ sportId: w.cricket.id }, { upazilaId: w.galachipa.id }, { districtId: w.dhaka.id }, { status: "COMPLETED" }, { playersAccepted: 1 }, { isHidden: true }]) {
      expect((await patch(cap.auth, `/requests/${id}`, body)).status).toBe(422);
    }
    expect((await patch(cap.auth, `/requests/${id}`, {})).status).toBe(422);
  });

  it("is owner-only", async () => {
    const { id } = await setup();
    const other = await signedIn("other@example.com");
    const res = await patch(other.auth, `/requests/${id}`, { notes: "hijack" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REQUEST_NOT_OWNER");
    expect((await patch(other.auth, `/requests/nope`, { notes: "x" })).body.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it.each(["CANCELLED", "COMPLETED"] as const)("refuses to edit a %s request", async (status) => {
    const { cap, userId } = await setup();
    const r = await makeRequest(w, userId, { status });
    const res = await patch(cap.auth, `/requests/${r.id}`, { notes: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_CLOSED");
  });

  it("validates the merged result: past time, free+budget, inverted budget, unknown position", async () => {
    const { cap, id } = await setup();
    await patch(cap.auth, `/requests/${id}`, { isPaid: true, budgetMin: 100, budgetMax: 300 });
    expect((await patch(cap.auth, `/requests/${id}`, { matchAt: hoursFromNow(-1).toISOString() })).status).toBe(422);
    expect((await patch(cap.auth, `/requests/${id}`, { budgetMax: 50 })).status).toBe(422); // below existing min
    expect((await patch(cap.auth, `/requests/${id}`, { positionsNeeded: ["NOPE"] })).status).toBe(422);
    expect((await patch(cap.auth, `/requests/${id}`, { isPaid: false, budgetMin: 100 })).status).toBe(422);
  });

  it("switching to free clears the budget", async () => {
    const { cap, id } = await setup();
    await patch(cap.auth, `/requests/${id}`, { isPaid: true, budgetMin: 100, budgetMax: 300 });
    const res = await patch(cap.auth, `/requests/${id}`, { isPaid: false });
    expect(res.body.data).toMatchObject({ isPaid: false, budgetMin: null, budgetMax: null });
  });

  it("playersNeeded can't drop below accepted, and moves the request between OPEN and FILLED", async () => {
    const { cap, id } = await setup();
    await prisma.playerRequest.update({ where: { id }, data: { playersAccepted: 2 } });
    expect((await patch(cap.auth, `/requests/${id}`, { playersNeeded: 1 })).body.error.code).toBe("VALIDATION_ERROR");

    const fills = await patch(cap.auth, `/requests/${id}`, { playersNeeded: 2 });
    expect(fills.body.data).toMatchObject({ status: "FILLED", spotsLeft: 0 });
    const reopens = await patch(cap.auth, `/requests/${id}`, { playersNeeded: 4 });
    expect(reopens.body.data).toMatchObject({ status: "OPEN", spotsLeft: 2 });
  });

  it("notifies accepted players when the time or venue changes — but not for a notes-only edit", async () => {
    const { cap, id } = await setup();
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const waiting = await playerUser(w, "w@example.com", [{ sportId: w.football.id }]);
    await makeApplication(id, p.user.id, "ACCEPTED");
    await makeApplication(id, waiting.user.id, "PENDING");
    await prisma.playerRequest.update({ where: { id }, data: { playersAccepted: 1 } });
    await settle();
    await prisma.notification.deleteMany();

    await patch(cap.auth, `/requests/${id}`, { notes: "just notes" });
    await settle();
    expect(await prisma.notification.count()).toBe(0);

    await patch(cap.auth, `/requests/${id}`, { venueText: "New venue" });
    await settle();
    const rows = await prisma.notification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.user.id, type: "REQUEST_UPDATED" });
    expect(rows[0]!.data).toMatchObject({ requestId: id, venue: "New venue" });
  });
});

describe("cancel / fill / complete", () => {
  it("cancel: closes the request, rejects pending applicants, and notifies accepted + pending (not rejected) players", async () => {
    const cap = await signedIn("cap@example.com");
    const r = await makeRequest(w, cap.user.id, { playersNeeded: 3, playersAccepted: 1 });
    const acc = await playerUser(w, "acc@example.com");
    const pen = await playerUser(w, "pen@example.com");
    const rej = await playerUser(w, "rej@example.com");
    await makeApplication(r.id, acc.user.id, "ACCEPTED");
    await makeApplication(r.id, pen.user.id, "PENDING");
    await makeApplication(r.id, rej.user.id, "REJECTED");

    const res = await post(cap.auth, `/requests/${r.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CANCELLED");
    await settle();

    const statuses = Object.fromEntries((await prisma.application.findMany()).map((a) => [a.playerId, a.status]));
    expect(statuses).toEqual({ [acc.user.id]: "ACCEPTED", [pen.user.id]: "REJECTED", [rej.user.id]: "REJECTED" });
    const notified = (await prisma.notification.findMany({ where: { type: "REQUEST_CANCELLED" } })).map((n) => n.userId).sort();
    expect(notified).toEqual([acc.user.id, pen.user.id].sort());
  });

  it("cancel works on FILLED, is owner-only, and can't be repeated", async () => {
    const cap = await signedIn("cap@example.com");
    const other = await signedIn("other@example.com");
    const r = await makeRequest(w, cap.user.id, { status: "FILLED" });
    expect((await post(other.auth, `/requests/${r.id}/cancel`)).status).toBe(403);
    expect((await post(cap.auth, `/requests/${r.id}/cancel`)).status).toBe(200);
    const again = await post(cap.auth, `/requests/${r.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REQUEST_CLOSED");
  });

  it("fill: OPEN → FILLED; anything else is REQUEST_NOT_OPEN; owner only", async () => {
    const cap = await signedIn("cap@example.com");
    const other = await signedIn("other@example.com");
    const r = await makeRequest(w, cap.user.id);
    expect((await post(other.auth, `/requests/${r.id}/fill`)).status).toBe(403);
    expect((await post(cap.auth, `/requests/${r.id}/fill`)).body.data.status).toBe("FILLED");
    expect((await post(cap.auth, `/requests/${r.id}/fill`)).body.error.code).toBe("REQUEST_NOT_OPEN");
  });

  it("complete: needs the match to have started and ≥1 accepted player, then starts the rating window", async () => {
    const cap = await signedIn("cap@example.com");
    const p = await playerUser(w, "p@example.com");
    const future = await makeRequest(w, cap.user.id, { status: "FILLED", playersAccepted: 2 });
    expect((await post(cap.auth, `/requests/${future.id}/complete`)).body.error.code).toBe("REQUEST_NOT_STARTED");

    const empty = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-3) });
    expect((await post(cap.auth, `/requests/${empty.id}/complete`)).body.error.code).toBe("REQUEST_NO_ACCEPTED_PLAYERS");

    const played = await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(-3), playersAccepted: 1, playersNeeded: 2 });
    await makeApplication(played.id, p.user.id, "ACCEPTED");
    const pending = await playerUser(w, "pending@example.com");
    await makeApplication(played.id, pending.user.id, "PENDING");

    const res = await post(cap.auth, `/requests/${played.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("COMPLETED");
    const row = await prisma.playerRequest.findUniqueOrThrow({ where: { id: played.id } });
    expect(Date.now() - row.completedAt!.getTime()).toBeLessThan(10_000);
    expect((await prisma.application.findFirstOrThrow({ where: { playerId: pending.user.id } })).status).toBe("REJECTED");

    expect((await post(cap.auth, `/requests/${played.id}/complete`)).body.error.code).toBe("REQUEST_CLOSED");
  });

  it("complete and fill refuse a cancelled request / non-owner", async () => {
    const cap = await signedIn("cap@example.com");
    const other = await signedIn("other@example.com");
    const r = await makeRequest(w, cap.user.id, { status: "CANCELLED", matchAt: hoursFromNow(-1), playersAccepted: 1 });
    expect((await post(cap.auth, `/requests/${r.id}/complete`)).body.error.code).toBe("REQUEST_CLOSED");
    expect((await post(other.auth, `/requests/${r.id}/complete`)).status).toBe(403);
  });
});

describe("GET /requests/:id", () => {
  it("shows owner and non-owner views, including my own application", async () => {
    const cap = await signedIn("cap@example.com");
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id }]);
    const r = await makeRequest(w, cap.user.id);
    const app = await makeApplication(r.id, p.user.id, "PENDING");

    const asOwner = await get(cap.auth, `/requests/${r.id}`);
    expect(asOwner.body.data).toMatchObject({ isOwner: true, myApplication: null });
    const asPlayer = await get(p.auth, `/requests/${r.id}`);
    expect(asPlayer.body.data).toMatchObject({ isOwner: false, myApplication: { id: app.id, status: "PENDING" } });
  });

  it("hides hidden and suspended-poster requests from everyone but the poster", async () => {
    const cap = await signedIn("cap@example.com");
    const viewer = await signedIn("viewer2@example.com");
    const hidden = await makeRequest(w, cap.user.id, { isHidden: true });
    expect((await get(viewer.auth, `/requests/${hidden.id}`)).status).toBe(404);
    expect((await get(cap.auth, `/requests/${hidden.id}`)).status).toBe(200);

    const visible = await makeRequest(w, cap.user.id);
    await prisma.user.update({ where: { id: cap.user.id }, data: { status: "SUSPENDED" } });
    expect((await get(viewer.auth, `/requests/${visible.id}`)).status).toBe(404);
  });

  it("404s for unknown ids and requires auth", async () => {
    const { auth } = await signedIn();
    expect((await get(auth, "/requests/doesnotexist")).body.error.code).toBe("REQUEST_NOT_FOUND");
    expect((await api().get(`${V1}/requests/x`)).status).toBe(401);
  });
});

describe("GET /requests (feed)", () => {
  let cap: Awaited<ReturnType<typeof signedIn>>;
  let viewer: Awaited<ReturnType<typeof signedIn>>;
  beforeEach(async () => {
    cap = await signedIn("cap@example.com");
    viewer = await signedIn("viewer2@example.com");
  });
  const venues = (res: { body: { data: Array<{ venueText: string }> } }) => res.body.data.map((r) => r.venueText);

  it("lists only open, upcoming, visible requests from other people", async () => {
    await makeRequest(w, cap.user.id, { venueText: "ok" });
    await makeRequest(w, viewer.user.id, { venueText: "mine" });
    await makeRequest(w, cap.user.id, { venueText: "hidden", isHidden: true });
    await makeRequest(w, cap.user.id, { venueText: "filled", status: "FILLED" });
    await makeRequest(w, cap.user.id, { venueText: "cancelled", status: "CANCELLED" });
    await makeRequest(w, cap.user.id, { venueText: "completed", status: "COMPLETED" });
    await makeRequest(w, cap.user.id, { venueText: "past", matchAt: hoursFromNow(-1) });
    const sus = await signedIn("sus@example.com");
    await makeRequest(w, sus.user.id, { venueText: "suspended poster" });
    await prisma.user.update({ where: { id: sus.user.id }, data: { status: "SUSPENDED" } });

    expect(venues(await get(viewer.auth, "/requests"))).toEqual(["ok"]);
  });

  it("filters by sport, location level, paid flag and position (including any-position requests)", async () => {
    await makeRequest(w, cap.user.id, { venueText: "fb-gk-k", positionsNeeded: ["GK"] });
    await makeRequest(w, cap.user.id, { venueText: "fb-any-k", positionsNeeded: [] });
    await makeRequest(w, cap.user.id, { venueText: "fb-st-g", positionsNeeded: ["ST"], upazilaId: w.galachipa.id });
    await makeRequest(w, cap.user.id, { venueText: "cr-k", sportId: w.cricket.id, positionsNeeded: ["BATTER"], isPaid: true, budgetMin: 100, budgetMax: 200 });
    await makeRequest(w, cap.user.id, { venueText: "dhaka", districtId: w.dhaka.id, upazilaId: w.savar.id });
    await makeRequest(w, cap.user.id, { venueText: "union", unionId: w.latachapli.id });
    const q = async (query: Record<string, string | number | boolean>) => venues(await get(viewer.auth, "/requests", query)).sort();

    expect(await q({ sportId: w.cricket.id })).toEqual(["cr-k"]);
    expect(await q({ districtId: w.dhaka.id })).toEqual(["dhaka"]);
    expect(await q({ upazilaId: w.galachipa.id })).toEqual(["fb-st-g"]);
    expect(await q({ unionId: w.latachapli.id })).toEqual(["union"]);
    expect(await q({ isPaid: true })).toEqual(["cr-k"]);
    // GK in Kalapara: the GK request plus every request open to any position ("union" lists none).
    expect(await q({ sportId: w.football.id, position: "GK", upazilaId: w.kalapara.id })).toEqual(["fb-any-k", "fb-gk-k", "union"]);
  });

  it("position filter without a sport is a 422", async () => {
    expect((await get(viewer.auth, "/requests", { position: "GK" })).status).toBe(422);
  });

  it("orders soonest first and pages through identical times without repeats or gaps", async () => {
    const same = hoursFromNow(30);
    const made = [];
    for (let i = 0; i < 5; i++) made.push((await makeRequest(w, cap.user.id, { matchAt: same })).id);
    made.push((await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(10) })).id);
    made.push((await makeRequest(w, cap.user.id, { matchAt: hoursFromNow(60) })).id);

    const full = (await get(viewer.auth, "/requests", { limit: 50 })).body.data.map((r: { id: string }) => r.id);
    expect(full).toHaveLength(7);
    expect(full[0]).toBe(made[5]); // 10h
    expect(full[6]).toBe(made[6]); // 60h

    const paged: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await get(viewer.auth, "/requests", cursor ? { limit: 3, cursor } : { limit: 3 });
      paged.push(...res.body.data.map((r: { id: string }) => r.id));
      cursor = res.body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(paged).toEqual(full);
  });

  it("flags requests I already applied to", async () => {
    const r = await makeRequest(w, cap.user.id);
    await makeRequest(w, cap.user.id);
    const app = await makeApplication(r.id, viewer.user.id);
    const res = await get(viewer.auth, "/requests");
    const byId = Object.fromEntries(res.body.data.map((x: { id: string; myApplication: unknown }) => [x.id, x.myApplication]));
    expect(byId[r.id]).toEqual({ id: app.id, status: "PENDING" });
    expect(Object.values(byId).filter((v) => v === null)).toHaveLength(1);
  });

  it("rejects a bad cursor and bad limits; requires auth", async () => {
    expect((await get(viewer.auth, "/requests", { cursor: "!!!" })).status).toBe(422);
    expect((await get(viewer.auth, "/requests", { limit: 0 })).status).toBe(422);
    expect((await get(viewer.auth, "/requests", { limit: 51 })).status).toBe(422);
    expect((await api().get(`${V1}/requests`)).status).toBe(401);
  });
});

describe("GET /requests/mine", () => {
  it("lists my requests of every status, newest first, with pending-applicant counts", async () => {
    const cap = await signedIn("cap@example.com");
    const other = await signedIn("other@example.com");
    const a = await makeRequest(w, cap.user.id, { venueText: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await makeRequest(w, cap.user.id, { venueText: "B", status: "CANCELLED" });
    await makeRequest(w, other.user.id, { venueText: "not mine" });
    const p1 = await playerUser(w, "p1@example.com");
    const p2 = await playerUser(w, "p2@example.com");
    await makeApplication(a.id, p1.user.id, "PENDING");
    await makeApplication(a.id, p2.user.id, "ACCEPTED");

    const res = await get(cap.auth, "/requests/mine");
    expect(res.body.data.map((r: { venueText: string }) => r.venueText)).toEqual(["B", "A"]);
    const byVenue = Object.fromEntries(res.body.data.map((r: { venueText: string }) => [r.venueText, r]));
    expect(byVenue.A).toMatchObject({ pendingApplicants: 1, isOwner: true });
    expect(byVenue.B.pendingApplicants).toBe(0);

    expect((await get(cap.auth, "/requests/mine", { status: "CANCELLED" })).body.data.map((r: { venueText: string }) => r.venueText)).toEqual(["B"]);
    expect((await get(cap.auth, "/requests/mine", { status: "BOGUS" })).status).toBe(422);
  });
});
