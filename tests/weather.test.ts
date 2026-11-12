import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeApplication, makeRequest, notificationsOf, playerUser, prisma, resetDb, seedWorld, settle, signedIn, type World } from "./helpers.js";
import { clearWeatherCache, levelOf, sendRainAlerts, weatherDeps } from "../src/modules/weather/weather.service.js";

let w: World;
const realFetch = weatherDeps.fetch;
let calls: string[] = [];

/** An Open-Meteo answer with one rainy or dry hour at the given instant. */
function forecast(at: Date, p: number, mm: number) {
  const hours = Array.from({ length: 6 }, (_, i) => new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000 + (i - 1) * 3_600_000));
  weatherDeps.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ hourly: { time: hours.map((d) => d.toISOString().slice(0, 16)), precipitation_probability: hours.map((_, i) => (i === 2 ? p : 5)), precipitation: hours.map((_, i) => (i === 2 ? mm : 0)) } }), { status: 200 });
  };
}

beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  await prisma.upazila.update({ where: { id: w.kalapara.id }, data: { lat: 21.99, lng: 90.22 } });
  clearWeatherCache();
  calls = [];
});
afterEach(() => {
  weatherDeps.fetch = realFetch;
});

describe("rain outlook", () => {
  it("levels", () => {
    expect(levelOf(70, 0)).toBe("LIKELY");
    expect(levelOf(10, 3)).toBe("LIKELY");
    expect(levelOf(40, 0.2)).toBe("POSSIBLE");
    expect(levelOf(10, 0)).toBe("UNLIKELY");
  });

  it("the game's weather comes from Open-Meteo for the area centre only, and is cached", async () => {
    const org = await signedIn("org@example.com");
    const g = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(30) });
    forecast(g.matchAt, 80, 3.4);
    const res = await api().get(`${V1}/requests/${g.id}/weather`).set(org.auth);
    expect(res.body.data).toMatchObject({ level: "LIKELY", rainChance: 80 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("latitude=21.99");
    expect(calls[0]).toContain("longitude=90.22");
    expect(calls[0]).not.toMatch(/email|user|name/i);
    await api().get(`${V1}/requests/${g.id}/weather`).set(org.auth);
    expect(calls).toHaveLength(1); // second look served from the cache
  });

  it("is null when the service fails, the match is past, or it is too far ahead", async () => {
    const org = await signedIn("org@example.com");
    weatherDeps.fetch = async () => new Response("no", { status: 500 });
    const near = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(10) });
    expect((await api().get(`${V1}/requests/${near.id}/weather`).set(org.auth)).body.data).toBeNull();
    const far = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(24 * 20) });
    expect((await api().get(`${V1}/requests/${far.id}/weather`).set(org.auth)).body.data).toBeNull();
    const past = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-2) });
    expect((await api().get(`${V1}/requests/${past.id}/weather`).set(org.auth)).body.data).toBeNull();
  });
});

describe("rain alerts", () => {
  it("tells the organiser and accepted players once when rain is likely within a day", async () => {
    const org = await signedIn("org@example.com");
    const p = await playerUser(w, "p@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    const waiting = await playerUser(w, "wait@example.com", [{ sportId: w.football.id, positions: ["GK"] }]);
    const g = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(10) });
    await makeApplication(g.id, p.user.id, "ACCEPTED");
    await makeApplication(g.id, waiting.user.id, "PENDING");
    forecast(g.matchAt, 85, 4);

    expect(await sendRainAlerts()).toBe(1);
    await settle();
    expect(await notificationsOf(org.user.id, "RAIN_ALERT")).toHaveLength(1);
    expect(await notificationsOf(p.user.id, "RAIN_ALERT")).toHaveLength(1);
    expect(await notificationsOf(waiting.user.id, "RAIN_ALERT")).toHaveLength(0);
    expect(await sendRainAlerts()).toBe(0); // never twice for one game
  });

  it("stays quiet for dry weather, far-off games and cancelled games", async () => {
    const org = await signedIn("org@example.com");
    const dry = await makeRequest(w, org.user.id, { matchAt: hoursFromNow(10) });
    forecast(dry.matchAt, 5, 0);
    expect(await sendRainAlerts()).toBe(0);
    expect((await prisma.playerRequest.findUniqueOrThrow({ where: { id: dry.id } })).rainAlertedAt).toBeNull(); // looked again next hour
    await makeRequest(w, org.user.id, { matchAt: hoursFromNow(48) });
    await makeRequest(w, org.user.id, { matchAt: hoursFromNow(10), status: "CANCELLED" });
    forecast(hoursFromNow(10), 90, 5);
    clearWeatherCache();
    expect(await sendRainAlerts()).toBe(1); // only the dry-forecast game is still eligible and now rains
  });
});
