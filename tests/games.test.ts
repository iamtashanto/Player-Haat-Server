import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, playerUser, prisma, requestBody, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

let w: World;
let org: Awaited<ReturnType<typeof playerUser>>;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  org = await playerUser(w, "org@example.com", [{ sportId: w.football.id }]);
});

const FB = () => [{ sportId: w.football.id }];
const post = (auth: Record<string, string>, over: Record<string, unknown> = {}) => api().post(`${V1}/requests`).set(auth).send(requestBody(w, over));
const join = (auth: Record<string, string>, requestId: string) => api().post(`${V1}/requests/${requestId}/applications`).set(auth).send({});
const chat = (auth: Record<string, string>, id: string) => api().get(`${V1}/games/${id}/chat`).set(auth);
const say = (auth: Record<string, string>, id: string, body = "hello") => api().post(`${V1}/games/${id}/chat/messages`).set(auth).send({ body });
const hist = (auth: Record<string, string>, id: string, q: object = {}) => api().get(`${V1}/games/${id}/chat/messages`).set(auth).query(q);
const startedGame = (over: Parameters<typeof makeRequest>[2] = {}) => makeRequest(w, org.user.id, { matchAt: hoursFromNow(-3), playersNeeded: 4, ...over });

describe("join without approval", () => {
  it("accepts instantly, fills at capacity, refuses the next player, and frees a spot on leave", async () => {
    const game = (await post(org.auth, { joinMode: "OPEN_JOIN", playersNeeded: 2 })).body.data;
    expect(game.joinMode).toBe("OPEN_JOIN");
    const a = await playerUser(w, "a@example.com", FB());
    const b = await playerUser(w, "b@example.com", FB());
    const c = await playerUser(w, "c@example.com", FB());

    const ja = await join(a.auth, game.id);
    expect(ja.status).toBe(201);
    expect(ja.body.data.status).toBe("ACCEPTED");
    expect((await join(b.auth, game.id)).body.data.status).toBe("ACCEPTED");
    const full = await prisma.playerRequest.findUniqueOrThrow({ where: { id: game.id } });
    expect(full).toMatchObject({ status: "FILLED", playersAccepted: 2 });

    const late = await join(c.auth, game.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("REQUEST_FILLED");

    await api().post(`${V1}/applications/${ja.body.data.id}/withdraw`).set(a.auth);
    expect(await prisma.playerRequest.findUniqueOrThrow({ where: { id: game.id } })).toMatchObject({ status: "OPEN", playersAccepted: 1 });
    expect((await join(c.auth, game.id)).body.data.status).toBe("ACCEPTED");
  });

  it("never over-fills when players join at the same moment", async () => {
    const game = (await post(org.auth, { joinMode: "OPEN_JOIN", playersNeeded: 2 })).body.data;
    const ps = await Promise.all(["p1", "p2", "p3", "p4"].map((n) => playerUser(w, `${n}@example.com`, FB())));
    const results = await Promise.all(ps.map((p) => join(p.auth, game.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: game.id } })).playersAccepted).toBe(2);
  });

  it("approval games still wait for the organiser, and a pending player is not in the chat", async () => {
    const game = (await post(org.auth, { playersNeeded: 2 })).body.data;
    expect(game.joinMode).toBe("APPROVAL");
    const a = await playerUser(w, "a@example.com", FB());
    const j = await join(a.auth, game.id);
    expect(j.body.data.status).toBe("PENDING");
    expect((await chat(a.auth, game.id)).status).toBe(404); // pending isn't a member
  });

  it("is for matches only, and the organiser can't join their own", async () => {
    const rec = await signedIn("rec@example.com");
    await prisma.user.update({ where: { id: rec.user.id }, data: { role: "RECRUITER" } });
    const ev = await post(rec.auth, { kind: "EVENT", title: "U17 trial", joinMode: "OPEN_JOIN" });
    expect(ev.status).toBe(422);
    const game = (await post(org.auth, { joinMode: "OPEN_JOIN" })).body.data;
    expect((await join(org.auth, game.id)).status).toBe(403);
  });
});

describe("game chat", () => {
  it("exists from the start for the organiser and accepted players only", async () => {
    const game = (await post(org.auth, { joinMode: "OPEN_JOIN", playersNeeded: 3 })).body.data;
    const a = await playerUser(w, "a@example.com", FB());
    const outsider = await playerUser(w, "x@example.com", FB());

    expect((await chat(org.auth, game.id)).body.data).toMatchObject({ gameId: game.id, archived: false, canPost: true });
    expect((await chat(a.auth, game.id)).status).toBe(404);
    await join(a.auth, game.id);

    expect((await say(a.auth, game.id, "see you at 5")).status).toBe(201);
    expect((await say(org.auth, game.id, "bring water")).body.data.sender.isOrganiser).toBe(true);
    const msgs = (await hist(a.auth, game.id)).body.data;
    expect(msgs.map((m: { body: string }) => m.body)).toEqual(["bring water", "see you at 5"]);
    expect(msgs[1].mine).toBe(true);
    expect((await chat(a.auth, game.id)).body.data.members.map((m: { isOrganiser: boolean }) => m.isOrganiser)).toEqual([true, false]);

    for (const r of [await chat(outsider.auth, game.id), await hist(outsider.auth, game.id), await say(outsider.auth, game.id)]) expect(r.status).toBe(404);
    expect((await api().get(`${V1}/games/${game.id}/chat`)).status).toBe(401);
  });

  it("a player who leaves loses access; one who rejoins gets it back", async () => {
    const game = (await post(org.auth, { joinMode: "OPEN_JOIN", playersNeeded: 3 })).body.data;
    const a = await playerUser(w, "a@example.com", FB());
    const j = await join(a.auth, game.id);
    await say(a.auth, game.id);
    await api().post(`${V1}/applications/${j.body.data.id}/withdraw`).set(a.auth);
    expect((await hist(a.auth, game.id)).status).toBe(404);
    await join(a.auth, game.id);
    expect((await hist(a.auth, game.id)).body.data).toHaveLength(1);
  });

  it("pages backwards and polls forwards", async () => {
    const game = (await post(org.auth)).body.data;
    for (const t of ["one", "two", "three"]) await say(org.auth, game.id, t);
    const newest = (await hist(org.auth, game.id, { limit: 2 })).body.data;
    expect(newest.map((m: { body: string }) => m.body)).toEqual(["three", "two"]);
    const older = (await hist(org.auth, game.id, { before: newest[1].id })).body.data;
    expect(older.map((m: { body: string }) => m.body)).toEqual(["one"]);
    const fresh = (await hist(org.auth, game.id, { after: older[0].id })).body.data;
    expect(fresh.map((m: { body: string }) => m.body)).toEqual(["two", "three"]);
    expect((await hist(org.auth, game.id, { after: "nope" })).status).toBe(422);
  });

  it("turns read-only 7 days after the game — still readable, no longer writable", async () => {
    const live = await startedGame({ matchAt: hoursFromNow(-24 * 6) });
    const old = await startedGame({ matchAt: hoursFromNow(-24 * 8) });
    await prisma.gameMessage.create({ data: { requestId: old.id, senderId: org.user.id, body: "gg" } });

    expect((await chat(org.auth, live.id)).body.data).toMatchObject({ archived: false, canPost: true });
    expect((await say(org.auth, live.id)).status).toBe(201);
    expect((await chat(org.auth, old.id)).body.data).toMatchObject({ archived: true, canPost: false });
    expect((await hist(org.auth, old.id)).body.data).toHaveLength(1);
    const blocked = await say(org.auth, old.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("GAME_CHAT_ARCHIVED");
  });

  it("the 7 days count from completion when that is later; a cancelled game is read-only at once", async () => {
    const lateDone = await startedGame({ matchAt: hoursFromNow(-24 * 8) });
    await prisma.playerRequest.update({ where: { id: lateDone.id }, data: { completedAt: hoursFromNow(-24) } });
    expect((await chat(org.auth, lateDone.id)).body.data.archived).toBe(false);

    const game = (await post(org.auth)).body.data;
    await api().post(`${V1}/requests/${game.id}/cancel`).set(org.auth);
    expect((await chat(org.auth, game.id)).body.data).toMatchObject({ archived: true, canPost: false });
    expect((await say(org.auth, game.id)).status).toBe(409);
  });

  it("is not available for events or moderated games, and lists mine with live chats first", async () => {
    const hidden = await makeRequest(w, org.user.id, { isHidden: true });
    expect((await chat(org.auth, hidden.id)).status).toBe(404);
    const old = await startedGame({ matchAt: hoursFromNow(-24 * 8) });
    const soon = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(5) });
    const list = (await api().get(`${V1}/games/chats`).set(org.auth)).body.data;
    expect(list.map((c: { gameId: string }) => c.gameId)).toEqual([soon.id, old.id]);
  });
});

describe("attendance", () => {
  const roster = async () => {
    const game = await startedGame();
    const a = await playerUser(w, "a@example.com", FB());
    const b = await playerUser(w, "b@example.com", FB());
    const pending = await playerUser(w, "pending@example.com", FB());
    const appA = await makeApplication(game.id, a.user.id, "ACCEPTED");
    const appB = await makeApplication(game.id, b.user.id, "ACCEPTED");
    const appP = await makeApplication(game.id, pending.user.id, "PENDING");
    return { game, a, b, appA, appB, appP };
  };
  const mark = (auth: Record<string, string>, id: string, marks: object[]) => api().put(`${V1}/games/${id}/attendance`).set(auth).send({ marks });

  it("only the organiser can mark, only after the game started, only accepted players", async () => {
    const { game, a, appA, appB, appP } = await roster();
    expect((await mark(a.auth, game.id, [{ applicationId: appA.id, status: "ATTENDED" }])).status).toBe(403);
    const future = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(5) });
    expect((await mark(org.auth, future.id, [{ applicationId: appA.id, status: "ATTENDED" }])).body.error.code).toBe("REQUEST_NOT_STARTED");
    expect((await mark(org.auth, game.id, [{ applicationId: appP.id, status: "ATTENDED" }])).status).toBe(422);
    expect((await mark(org.auth, game.id, [{ applicationId: "nope", status: "ATTENDED" }])).status).toBe(422);
    const ok = await mark(org.auth, game.id, [{ applicationId: appA.id, status: "ATTENDED" }, { applicationId: appB.id, status: "NO_SHOW" }]);
    expect(ok.status).toBe(200);
    expect(ok.body.data.items).toHaveLength(2);
    expect(ok.body.data.items.find((i: { applicationId: string }) => i.applicationId === appB.id).attendance).toBe("NO_SHOW");
  });

  it("can be corrected, and closes 14 days after the game", async () => {
    const { game, appA } = await roster();
    await mark(org.auth, game.id, [{ applicationId: appA.id, status: "NO_SHOW" }]);
    await mark(org.auth, game.id, [{ applicationId: appA.id, status: "ATTENDED" }]);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: appA.id } })).attendance).toBe("ATTENDED");
    const old = await startedGame({ matchAt: hoursFromNow(-24 * 15) });
    expect((await mark(org.auth, old.id, [{ applicationId: appA.id, status: "ATTENDED" }])).body.error.code).toBe("ATTENDANCE_WINDOW_CLOSED");
  });

  it("feeds the reliability score on the public profile, search cards and the applicants list", async () => {
    const { game, a, b, appA, appB } = await roster();
    await mark(org.auth, game.id, [{ applicationId: appA.id, status: "ATTENDED" }, { applicationId: appB.id, status: "NO_SHOW" }]);
    const second = await startedGame();
    const appA2 = await makeApplication(second.id, a.user.id, "ACCEPTED");
    await mark(org.auth, second.id, [{ applicationId: appA2.id, status: "ATTENDED" }]);

    const viewer = await signedIn("viewer@example.com");
    const profileA = (await api().get(`${V1}/players/${a.profileId}`).set(viewer.auth)).body.data;
    expect(profileA.reliability).toEqual({ gamesPlayed: 2, noShows: 0, attendanceRate: 1, ratingAverage: 0, ratingCount: 0 });
    const profileB = (await api().get(`${V1}/players/${b.profileId}`).set(viewer.auth)).body.data;
    expect(profileB.reliability).toMatchObject({ gamesPlayed: 0, noShows: 1, attendanceRate: 0 });

    const found = (await api().get(`${V1}/players`).set(viewer.auth)).body.data;
    const card = (id: string) => found.find((p: { id: string }) => p.id === id).reliability;
    expect(card(a.profileId)).toMatchObject({ gamesPlayed: 2, attendanceRate: 1 });
    expect(card(b.profileId)).toMatchObject({ noShows: 1 });

    const applicants = (await api().get(`${V1}/requests/${game.id}/applications`).set(org.auth)).body.data;
    const row = applicants.find((x: { player: { id: string } }) => x.player.id === a.profileId);
    expect(row).toMatchObject({ attendance: "ATTENDED", player: { reliability: { gamesPlayed: 2 } } });
    const mine = (await api().get(`${V1}/players/me`).set(a.auth)).body.data;
    expect(mine.reliability.gamesPlayed).toBe(2);
  });

  it("an unmarked player has no attendance rate yet — and a mixed record is a fraction", async () => {
    const { a } = await roster();
    const viewer = await signedIn("viewer@example.com");
    expect((await api().get(`${V1}/players/${a.profileId}`).set(viewer.auth)).body.data.reliability).toMatchObject({ gamesPlayed: 0, attendanceRate: null });
    for (const status of ["ATTENDED", "ATTENDED", "NO_SHOW"] as const) {
      const g = await startedGame();
      const ap = await makeApplication(g.id, a.user.id, "ACCEPTED");
      await mark(org.auth, g.id, [{ applicationId: ap.id, status }]);
    }
    expect((await api().get(`${V1}/players/${a.profileId}`).set(viewer.auth)).body.data.reliability).toMatchObject({ gamesPlayed: 2, noShows: 1, attendanceRate: 0.667 });
  });
});
