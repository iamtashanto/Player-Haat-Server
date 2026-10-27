import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FANOUT, findMatchingPlayerIds } from "../src/modules/requests/matching.service.js";
import { fakePush } from "./fake-push.js";
import { V1, api, makeApplication, makeRequest, playerUser, prisma, requestBody, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const post = (a: Auth, path: string, body?: object) => api().post(`${V1}${path}`).set(a).send(body);
const get = (a: Auth, path: string, query: Record<string, string | number | boolean> = {}) => api().get(`${V1}${path}`).set(a).query(query);
const del = (a: Auth, path: string, body?: object) => api().delete(`${V1}${path}`).set(a).send(body);
const token = (n: string) => `fcm-${n}-`.padEnd(30, "x");
const addDevice = (userId: string, name: string, platform: "ANDROID" | "IOS" | "WEB" = "ANDROID") =>
  prisma.deviceToken.create({ data: { userId, token: token(name), platform } }).then(() => token(name));
const football = (extra: object = {}) => [{ sportId: w.football.id, positions: ["GK"], ...extra }];

describe("device tokens", () => {
  it("registers a token, and re-registering the same token updates it in place", async () => {
    const { auth, user } = await signedIn();
    expect((await post(auth, "/notifications/devices", { token: token("a"), platform: "ANDROID" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    await post(auth, "/notifications/devices", { token: token("a"), platform: "IOS" });
    const rows = await prisma.deviceToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "IOS" });
  });

  it("moves a token to the new account when someone else signs in on the same phone", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    await post(a.auth, "/notifications/devices", { token: token("shared"), platform: "ANDROID" });
    await post(b.auth, "/notifications/devices", { token: token("shared"), platform: "ANDROID" });
    const rows = await prisma.deviceToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(b.user.id);
  });

  it("unregisters my token, is idempotent, and can't remove someone else's", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    await post(a.auth, "/notifications/devices", { token: token("a"), platform: "ANDROID" });
    expect((await del(b.auth, "/notifications/devices", { token: token("a") })).status).toBe(200);
    expect(await prisma.deviceToken.count()).toBe(1); // b couldn't delete a's
    expect((await del(a.auth, "/notifications/devices", { token: token("a") })).status).toBe(200);
    expect((await del(a.auth, "/notifications/devices", { token: token("a") })).status).toBe(200);
    expect(await prisma.deviceToken.count()).toBe(0);
  });

  it("validates input and requires auth", async () => {
    const { auth } = await signedIn();
    expect((await post(auth, "/notifications/devices", { token: "short", platform: "ANDROID" })).status).toBe(422);
    expect((await post(auth, "/notifications/devices", { token: token("a"), platform: "SYMBIAN" })).status).toBe(422);
    expect((await post(auth, "/notifications/devices", { token: token("a"), platform: "ANDROID", userId: "x" })).status).toBe(422);
    expect((await api().post(`${V1}/notifications/devices`).send({ token: token("a"), platform: "IOS" })).status).toBe(401);
  });

  it("keeps at most 10 devices per user, dropping the stalest", async () => {
    const { auth, user } = await signedIn();
    for (let i = 0; i < 12; i++) {
      await post(auth, "/notifications/devices", { token: token(`d${i}`), platform: "ANDROID" });
      await new Promise((r) => setTimeout(r, 3));
    }
    const left = (await prisma.deviceToken.findMany({ where: { userId: user.id } })).map((d) => d.token);
    expect(left).toHaveLength(10);
    expect(left).not.toContain(token("d0"));
    expect(left).not.toContain(token("d1"));
    expect(left).toContain(token("d11"));
  });
});

describe("inbox", () => {
  const seed = (userId: string, n: number, over: Partial<{ readAt: Date | null }> = {}) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        prisma.notification.create({
          data: {
            userId,
            type: "NEW_APPLICANT",
            readAt: over.readAt ?? null,
            createdAt: new Date(Date.now() - i * 1000),
            data: { requestId: `r${i}`, sportBn: "ফুটবল", sportEn: "Football", venue: "Kuakata", matchAt: "2026-11-05T10:00:00.000Z", actor: "Sohel" },
          },
        }),
      ),
    );

  it("lists newest first, rendering title/body in the reader's language", async () => {
    const { auth, user } = await signedIn();
    await seed(user.id, 2);
    await api().patch(`${V1}/users/me`).set(auth).send({ locale: "en" });
    const en = await get(auth, "/notifications");
    expect(en.body.data).toHaveLength(2);
    expect(en.body.data[0]).toMatchObject({ type: "NEW_APPLICANT", title: "New applicant", readAt: null });
    expect(en.body.data[0].body).toContain("Sohel wants to play");
    expect(en.body.data[0].body).toContain("Football");
    expect(en.body.data[0].body).toContain("Kuakata");
    expect(en.body.data[0].data).toMatchObject({ requestId: "r0" });
    expect(en.body.meta).toMatchObject({ unreadCount: 2, nextCursor: null });

    await api().patch(`${V1}/users/me`).set(auth).send({ locale: "bn" });
    const bn = await get(auth, "/notifications");
    expect(bn.body.data[0].title).toBe("নতুন আবেদন এসেছে");
    expect(bn.body.data[0].body).toContain("ফুটবল");
  });

  it("only shows my own notifications", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    await seed(a.user.id, 3);
    expect((await get(b.auth, "/notifications")).body.data).toEqual([]);
    expect((await get(b.auth, "/notifications/unread-count")).body.data.count).toBe(0);
  });

  it("paginates, filters unread, and counts unread", async () => {
    const { auth, user } = await signedIn();
    await seed(user.id, 5);
    await seed(user.id, 2, { readAt: new Date() });
    expect((await get(auth, "/notifications/unread-count")).body.data.count).toBe(5);
    expect((await get(auth, "/notifications", { unreadOnly: true, limit: 50 })).body.data).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await get(auth, "/notifications", cursor ? { limit: 3, cursor } : { limit: 3 });
      seen.push(...res.body.data.map((n: { id: string }) => n.id));
      cursor = res.body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(7);
    expect((await get(auth, "/notifications", { cursor: "!!" })).status).toBe(422);
  });

  it("marks one read (idempotently), marks all read, and 404s on someone else's", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    const [first] = await seed(a.user.id, 3);

    expect((await post(b.auth, `/notifications/${first!.id}/read`)).status).toBe(404);
    const read = await post(a.auth, `/notifications/${first!.id}/read`);
    expect(read.body.data.readAt).toBeTruthy();
    const stamp = read.body.data.readAt;
    expect((await post(a.auth, `/notifications/${first!.id}/read`)).body.data.readAt).toBe(stamp);
    expect((await get(a.auth, "/notifications/unread-count")).body.data.count).toBe(2);

    expect((await post(a.auth, "/notifications/read-all")).body.data.updated).toBe(2);
    expect((await get(a.auth, "/notifications/unread-count")).body.data.count).toBe(0);
    expect((await post(a.auth, "/notifications/read-all")).body.data.updated).toBe(0);
    expect((await api().get(`${V1}/notifications`)).status).toBe(401);
  });
});

describe("push delivery", () => {
  const setup = async () => {
    const cap = await signedIn("cap@example.com");
    await prisma.user.update({ where: { id: cap.user.id }, data: { locale: "en" } }); // default is bn
    const request = await makeRequest(w, cap.user.id, { venueText: "Kuakata Sea Beach" });
    const player = await playerUser(w, "player@example.com", football());
    return { cap, request, player };
  };

  it("pushes to the poster's devices when someone applies, and also writes the inbox row", async () => {
    const { cap, request, player } = await setup();
    const t1 = await addDevice(cap.user.id, "cap-phone");
    const t2 = await addDevice(cap.user.id, "cap-tablet", "IOS");
    await post(player.auth, `/requests/${request.id}/applications`);
    await settle();

    expect(fakePush.sent).toHaveLength(1); // one FCM call for both devices
    expect(fakePush.sent[0]!.tokens.sort()).toEqual([t1, t2].sort());
    expect(fakePush.sent[0]!.message).toMatchObject({
      title: "New applicant",
      data: { type: "NEW_APPLICANT", requestId: request.id, actor: "Viewer", venue: "Kuakata Sea Beach" },
    });
    expect(Object.values(fakePush.sent[0]!.message.data).every((v) => typeof v === "string")).toBe(true);
    expect(await prisma.notification.count({ where: { userId: cap.user.id } })).toBe(1);
  });

  it("sends the copy in each recipient's language, one call per language", async () => {
    const { cap, request } = await setup();
    const bnUser = await playerUser(w, "bn@example.com", football());
    const enUser = await playerUser(w, "en@example.com", football());
    await prisma.user.update({ where: { id: enUser.user.id }, data: { locale: "en" } });
    const bnTok = await addDevice(bnUser.user.id, "bn");
    const enTok = await addDevice(enUser.user.id, "en");
    await makeApplication(request.id, bnUser.user.id);
    await makeApplication(request.id, enUser.user.id);
    const apps = await prisma.application.findMany();

    for (const a of apps) await post(cap.auth, `/applications/${a.id}/accept`);
    await settle();

    expect(fakePush.to(bnTok)[0]!.title).toBe("আপনার আবেদন গৃহীত হয়েছে 🎉");
    expect(fakePush.to(enTok)[0]!.title).toBe("You're in! 🎉");
    expect(fakePush.to(enTok)[0]!.body).toContain("Kuakata Sea Beach");
  });

  it("formats the match time in Dhaka time", async () => {
    const cap = await signedIn("cap@example.com");
    const player = await playerUser(w, "player@example.com", football());
    const tok = await addDevice(cap.user.id, "cap");
    await prisma.user.update({ where: { id: cap.user.id }, data: { locale: "en" } });
    const request = await makeRequest(w, cap.user.id, { matchAt: new Date("2030-06-15T10:30:00.000Z") }); // 16:30 in Dhaka (UTC+6)
    await post(player.auth, `/requests/${request.id}/applications`);
    await settle();
    expect(fakePush.to(tok)[0]!.body).toMatch(/16:30/);
  });

  it("still records the inbox row for a user with no devices, and sends nothing", async () => {
    const { cap, request, player } = await setup();
    await post(player.auth, `/requests/${request.id}/applications`);
    await settle();
    expect(fakePush.sent).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: cap.user.id } })).toBe(1);
  });

  it("prunes tokens the provider reports as dead", async () => {
    const { cap, request, player } = await setup();
    const dead = await addDevice(cap.user.id, "dead");
    const alive = await addDevice(cap.user.id, "alive");
    fakePush.deadTokens.add(dead);
    await post(player.auth, `/requests/${request.id}/applications`);
    await settle();
    expect((await prisma.deviceToken.findMany()).map((d) => d.token)).toEqual([alive]);
  });

  it("a push outage never breaks the request that triggered it", async () => {
    const { cap, request, player } = await setup();
    await addDevice(cap.user.id, "cap");
    fakePush.fail = true;
    const res = await post(player.auth, `/requests/${request.id}/applications`);
    await settle();
    expect(res.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: cap.user.id, type: "NEW_APPLICANT" } })).toBe(1);
  });

  it("doesn't notify suspended or deleted users", async () => {
    const cap = await signedIn("cap@example.com");
    const request = await makeRequest(w, cap.user.id);
    const player = await playerUser(w, "player@example.com", football());
    await addDevice(cap.user.id, "cap");
    await prisma.user.update({ where: { id: cap.user.id }, data: { status: "SUSPENDED" } });
    await post(player.auth, `/requests/${request.id}/applications`).catch(() => undefined);
    await settle();
    expect(fakePush.sent).toHaveLength(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("new-request fan-out (who hears about a request)", () => {
  type Spec = { sports?: Array<Record<string, unknown>>; extra?: { upazilaId?: number; districtId?: number; unionId?: number | null; avgRating?: number; isVisible?: boolean } };
  const mk = async (name: string, spec: Spec = {}) => {
    const p = await playerUser(w, `${name}@example.com`, (spec.sports ?? football()) as never, spec.extra);
    await addDevice(p.user.id, name);
    return p;
  };
  /** Posts a request via the API and returns the names (email local-part) of everyone notified. */
  async function postAndCollect(body: Record<string, unknown>, poster: string | Awaited<ReturnType<typeof signedIn>> = "poster") {
    const cap = typeof poster === "string" ? await signedIn(`${poster}@example.com`) : poster;
    const res = await post(cap.auth, "/requests", requestBody(w, body));
    expect(res.status).toBe(201);
    await settle();
    const rows = await prisma.notification.findMany({ where: { type: "NEW_MATCHING_REQUEST" }, include: { user: { select: { email: true } } } });
    expect(rows.every((r) => (r.data as { requestId: string }).requestId === res.body.data.id)).toBe(true);
    return { names: rows.map((r) => r.user.email!.split("@")[0]!).sort(), res, cap };
  }

  it("matches on sport, position and location — and says what the match is", async () => {
    await mk("gk");
    await mk("st", { sports: football({ positions: ["ST"] }) });
    await mk("cricketer", { sports: [{ sportId: w.cricket.id, positions: ["BATTER"] }] });
    await mk("far-gk", { extra: { upazilaId: w.galachipa.id } });
    await mk("dhaka-gk", { extra: { districtId: w.dhaka.id, upazilaId: w.savar.id } });
    const { names } = await postAndCollect({ positionsNeeded: ["GK"] });
    expect(names).toEqual(["gk"]);

    const push = fakePush.to(token("gk"))[0]!;
    expect(push.title).toBe("আপনার এলাকায় নতুন ম্যাচ"); // default locale is bn
    expect(push.data).toMatchObject({ type: "NEW_MATCHING_REQUEST", sportEn: "Football", venue: "Kuakata Sea Beach Ground" });
  });

  it("a request with no positions is open to every position", async () => {
    await mk("gk");
    await mk("st", { sports: football({ positions: ["ST"] }) });
    expect((await postAndCollect({ positionsNeeded: [] })).names).toEqual(["gk", "st"]);
  });

  it("honours each player's travel radius: UNION < UPAZILA < DISTRICT", async () => {
    await mk("home-upazila", { sports: football({ travelRadius: "UPAZILA" }) });
    await mk("neighbour-upazila", { sports: football({ travelRadius: "UPAZILA" }), extra: { upazilaId: w.galachipa.id } });
    await mk("neighbour-district", { sports: football({ travelRadius: "DISTRICT" }), extra: { upazilaId: w.galachipa.id } });
    await mk("union-same", { sports: football({ travelRadius: "UNION" }), extra: { unionId: w.latachapli.id } });
    await mk("union-other", { sports: football({ travelRadius: "UNION" }), extra: { unionId: w.mohipur.id } });
    await mk("union-none", { sports: football({ travelRadius: "UNION" }) });

    // Request in Kalapara with no union: UNION-radius players can't be "in" it.
    expect((await postAndCollect({ upazilaId: w.kalapara.id })).names).toEqual(["home-upazila", "neighbour-district"]);
  });

  it("a request pinned to a union reaches that union's UNION-radius players too", async () => {
    await mk("union-same", { sports: football({ travelRadius: "UNION" }), extra: { unionId: w.latachapli.id } });
    await mk("union-other", { sports: football({ travelRadius: "UNION" }), extra: { unionId: w.mohipur.id } });
    await mk("upazila", { sports: football({ travelRadius: "UPAZILA" }) });
    expect((await postAndCollect({ unionId: w.latachapli.id })).names).toEqual(["union-same", "upazila"]);
  });

  it("paid request: only khep players whose rate range overlaps the budget (negotiable counts)", async () => {
    await mk("club-only", { sports: football({ khepAvailable: false }) });
    await mk("cheap", { sports: football({ khepAvailable: true, rateMin: 200, rateMax: 350 }) });
    await mk("too-pricey", { sports: football({ khepAvailable: true, rateMin: 900, rateMax: 1200 }) });
    await mk("negotiable", { sports: football({ khepAvailable: true }) });
    expect((await postAndCollect({ isPaid: true, budgetMin: 300, budgetMax: 500 })).names).toEqual(["cheap", "negotiable"]);
  });

  it("free request: any player of the sport, khep or not", async () => {
    await mk("club-only", { sports: football({ khepAvailable: false }) });
    await mk("khep", { sports: football({ khepAvailable: true, rateMin: 500, rateMax: 800 }) });
    expect((await postAndCollect({ isPaid: false })).names).toEqual(["club-only", "khep"]);
  });

  it("matches a player's other sport entry, not a mix of fields from different entries", async () => {
    // Football: free-only club player. Cricket: khep. A paid FOOTBALL request must skip them.
    await mk("mixed", {
      sports: [
        { sportId: w.football.id, positions: ["GK"], khepAvailable: false },
        { sportId: w.cricket.id, positions: ["BATTER"], khepAvailable: true },
      ],
    });
    expect((await postAndCollect({ isPaid: true, budgetMin: 100, budgetMax: 200 })).names).toEqual([]);
  });

  it("never notifies the poster, hidden, admin-hidden, suspended players — or anyone twice", async () => {
    const poster = await signedIn("poster@example.com");
    await prisma.playerProfile.create({ data: { userId: poster.user.id, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, sports: { create: [{ sportId: w.football.id, positions: ["GK"], skillLevel: 3 }] } } });
    await addDevice(poster.user.id, "poster");
    await mk("visible");
    await mk("hidden", { extra: { isVisible: false } });
    const adminHidden = await mk("admin-hidden");
    await prisma.playerProfile.update({ where: { id: adminHidden.profileId }, data: { hiddenByAdminAt: new Date() } });
    const suspended = await mk("suspended");
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: "SUSPENDED" } });
    // a player with two football-matching entries can't exist (unique per sport), but two sports both matching "any" must still yield one notice
    await mk("two-sports", { sports: [{ sportId: w.football.id, positions: ["GK"] }, { sportId: w.cricket.id, positions: ["BATTER"] }] });

    const { names } = await postAndCollect({ positionsNeeded: [] }, poster);
    expect(names).toEqual(["two-sports", "visible"]);
    expect(fakePush.to(token("poster"))).toEqual([]);
  });

  it("notifies nobody (and calls no push) when nobody matches", async () => {
    const { names } = await postAndCollect({});
    expect(names).toEqual([]);
    expect(fakePush.sent).toHaveLength(0);
  });

  it("returns the request even if announcing fails", async () => {
    await mk("gk");
    fakePush.fail = true;
    const { res } = await postAndCollect({ positionsNeeded: ["GK"] });
    expect(res.status).toBe(201);
  });
});

describe("findMatchingPlayerIds", () => {
  it("is capped and ranks best-rated players first", async () => {
    const cap = await signedIn("cap@example.com");
    const ratings = [4.9, 3.1, 4.2, 0, 4.9, 2.0];
    for (const [i, avg] of ratings.entries()) await playerUser(w, `p${i}@example.com`, football(), { avgRating: avg });
    const needs = { createdById: cap.user.id, sportId: w.football.id, positionsNeeded: [], isPaid: false, budgetMin: null, budgetMax: null, districtId: w.patuakhali.id, upazilaId: w.kalapara.id, unionId: null };

    const all = await findMatchingPlayerIds(needs);
    expect(all).toHaveLength(6);
    const top2 = await findMatchingPlayerIds(needs, 2);
    expect(top2).toEqual(all.slice(0, 2));
    const rated = await prisma.playerProfile.findMany({ where: { userId: { in: top2 } }, select: { avgRating: true } });
    expect(rated.map((r) => r.avgRating)).toEqual([4.9, 4.9]);
    expect(MAX_FANOUT).toBe(200);
  });
});
