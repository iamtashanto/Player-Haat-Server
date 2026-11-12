import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeRequest, notificationsOf, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";
import { nextOccurrence, postDueSeriesGames } from "../src/modules/series/series.service.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});
const call = (method: "get" | "post" | "patch" | "delete", path: string, a: Auth, body?: object) => {
  const t = api()[method](`${V1}${path}`).set(a);
  return body === undefined ? t : t.send(body);
};
const football = () => [{ sportId: w.football.id, positions: ["GK"] }];

/** A Friday 16:00 Dhaka game (10:00 UTC), some hours in the past or future. */
async function organiserWithGame(hoursFrom = 48) {
  const org = await signedIn("org@example.com");
  const game = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(hoursFrom), playersNeeded: 4 });
  return { org, game };
}
const weekly = async (a: Auth, requestId: string, title = "Friday football") => call("post", `/series/from-request/${requestId}`, a, { title });

describe("nextOccurrence", () => {
  it("finds the next given weekday at the given Dhaka time", () => {
    // Wed 2026-11-11 12:00 UTC = 18:00 Dhaka; the next Friday 16:00 Dhaka is Fri 2026-11-13 10:00 UTC
    expect(nextOccurrence(new Date("2026-11-11T12:00:00Z"), 5, "16:00").toISOString()).toBe("2026-11-13T10:00:00.000Z");
    // on the day but already past: a week later
    expect(nextOccurrence(new Date("2026-11-13T11:00:00Z"), 5, "16:00").toISOString()).toBe("2026-11-20T10:00:00.000Z");
    // the Dhaka date differs from the UTC date late in the evening: Thu 20:00 UTC = Fri 02:00 Dhaka
    expect(nextOccurrence(new Date("2026-11-12T20:00:00Z"), 5, "16:00").toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });
});

describe("making a game weekly", () => {
  it("copies the game, keeps its weekday and time, and links the source game", async () => {
    const { org, game } = await organiserWithGame();
    const res = await weekly(org.auth, game.id);
    expect(res.status).toBe(201);
    const local = new Date(game.matchAt.getTime() + 6 * 3_600_000);
    expect(res.body.data).toMatchObject({ title: "Friday football", weekday: local.getUTCDay(), venueText: game.venueText, playersNeeded: 4, isActive: true, isOwner: true, regularsCount: 0, nextGame: { id: game.id } });
    expect(res.body.data.startTime).toBe(`${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: game.id } })).seriesId).toBe(res.body.data.id);
    const seen = await call("get", `/requests/${game.id}`, org.auth);
    expect(seen.body.data.series).toMatchObject({ title: "Friday football" });
  });

  it("is only for the organiser, only for matches, and only once per game", async () => {
    const { org, game } = await organiserWithGame();
    const other = await playerUser(w, "p@example.com", football());
    expect((await weekly(other.auth, game.id)).status).toBe(403);
    expect((await weekly(org.auth, game.id, "x")).status).toBe(422);
    await prisma.playerRequest.update({ where: { id: game.id }, data: { kind: "EVENT" } });
    expect((await weekly(org.auth, game.id)).body.error.code).toBe("SERIES_MATCH_ONLY");
    await prisma.playerRequest.update({ where: { id: game.id }, data: { kind: "MATCH" } });
    expect((await weekly(org.auth, game.id)).status).toBe(201);
    expect((await weekly(org.auth, game.id)).body.error.code).toBe("SERIES_EXISTS");
  });

  it("caps the number of weekly games per organiser", async () => {
    const org = await signedIn("org@example.com");
    for (let i = 0; i < 5; i++) {
      const g = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(24 + i) });
      expect((await weekly(org.auth, g.id, `Game ${i}`)).status).toBe(201);
    }
    const extra = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(40) });
    expect((await weekly(org.auth, extra.id, "One too many")).body.error.code).toBe("SERIES_LIMIT");
  });
});

describe("regulars", () => {
  it("a player becomes a regular and leaves again; the organiser cannot join their own", async () => {
    const { org, game } = await organiserWithGame();
    const id = (await weekly(org.auth, game.id)).body.data.id as string;
    const p = await playerUser(w, "p@example.com", football());
    const joined = await call("post", `/series/${id}/regulars`, p.auth);
    expect(joined.body.data).toMatchObject({ isRegular: true, regularsCount: 1, isOwner: false });
    expect((await call("post", `/series/${id}/regulars`, p.auth)).status).toBe(200); // idempotent
    expect((await call("get", "/series/mine", p.auth)).body.data).toHaveLength(1);
    expect((await call("delete", `/series/${id}/regulars`, p.auth)).body.data).toMatchObject({ isRegular: false, regularsCount: 0 });
    expect((await call("post", `/series/${id}/regulars`, org.auth)).body.error.code).toBe("SERIES_OWN");
  });
});

describe("the weekly job", () => {
  it("posts nothing while a game is coming up", async () => {
    const { org, game } = await organiserWithGame(48);
    await weekly(org.auth, game.id);
    expect(await postDueSeriesGames()).toBe(0);
    expect(await prisma.playerRequest.count()).toBe(1);
  });

  it("posts next week's game after the last one has started, copies the details, and tells the regulars once", async () => {
    const { org, game } = await organiserWithGame(48);
    const id = (await weekly(org.auth, game.id)).body.data.id as string;
    const p = await playerUser(w, "p@example.com", football());
    await call("post", `/series/${id}/regulars`, p.auth);
    // the game has been played: move it a week back so the next slot is in the future
    await prisma.playerRequest.update({ where: { id: game.id }, data: { matchAt: hoursFromNow(-1), status: "COMPLETED" } });

    expect(await postDueSeriesGames()).toBe(1);
    const next = await prisma.playerRequest.findFirstOrThrow({ where: { seriesId: id, id: { not: game.id } } });
    const series = await prisma.gameSeries.findUniqueOrThrow({ where: { id } });
    expect(next).toMatchObject({ createdById: org.user.id, venueText: game.venueText, playersNeeded: 4, status: "OPEN", kind: "MATCH" });
    expect(next.matchAt.getTime()).toBeGreaterThan(Date.now());
    const local = new Date(next.matchAt.getTime() + 6 * 3_600_000);
    expect(local.getUTCDay()).toBe(series.weekday);
    expect(`${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`).toBe(series.startTime);

    await settle();
    expect(await notificationsOf(p.user.id, "SERIES_GAME_POSTED")).toHaveLength(1);
    expect(await postDueSeriesGames()).toBe(0); // running again changes nothing
    await settle();
    expect(await notificationsOf(p.user.id, "SERIES_GAME_POSTED")).toHaveLength(1);
  });

  it("a paused series posts nothing; resuming brings it back; a cancelled game is not re-posted at once", async () => {
    const { org, game } = await organiserWithGame(48);
    const id = (await weekly(org.auth, game.id)).body.data.id as string;
    await prisma.playerRequest.update({ where: { id: game.id }, data: { matchAt: hoursFromNow(-1), status: "COMPLETED" } });
    expect((await call("patch", `/series/${id}`, org.auth, { isActive: false })).body.data.isActive).toBe(false);
    expect(await postDueSeriesGames()).toBe(0);
    await call("patch", `/series/${id}`, org.auth, { isActive: true });
    expect(await postDueSeriesGames()).toBe(1);
    // the organiser cancels the new game: the series picks up the following week, not the same slot
    const second = await prisma.playerRequest.findFirstOrThrow({ where: { seriesId: id, status: "OPEN" } });
    await call("post", `/requests/${second.id}/cancel`, org.auth);
    expect(await postDueSeriesGames()).toBe(1);
    const third = await prisma.playerRequest.findFirstOrThrow({ where: { seriesId: id, status: "OPEN" } });
    expect(third.matchAt.getTime() - second.matchAt.getTime()).toBe(7 * 24 * 3_600_000);
  });

  it("only the organiser edits the series", async () => {
    const { org, game } = await organiserWithGame();
    const id = (await weekly(org.auth, game.id)).body.data.id as string;
    const p = await playerUser(w, "p@example.com", football());
    expect((await call("patch", `/series/${id}`, p.auth, { title: "Mine now" })).status).toBe(403);
    expect((await call("patch", `/series/${id}`, org.auth, { title: "Friday five-a-side", playersNeeded: 10 })).body.data).toMatchObject({ title: "Friday five-a-side", playersNeeded: 10 });
  });
});
