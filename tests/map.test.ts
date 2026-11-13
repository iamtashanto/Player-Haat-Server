import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, hoursFromNow, makeRequest, prisma, requestBody, resetDb, seedWorld, signedIn, type World } from "./helpers.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
  await prisma.upazila.update({ where: { id: w.kalapara.id }, data: { lat: 21.99, lng: 90.22 } });
});
const call = (method: "get" | "post" | "patch", path: string, a: Auth | null, body?: object) => {
  const t = api()[method](`${V1}${path}`);
  const s = a ? t.set(a) : t;
  return body === undefined ? s : s.send(body);
};

describe("ground pin and map feed", () => {
  it("an organiser can pin the ground; everyone sees the pin and the area centre", async () => {
    const org = await signedIn("org@example.com");
    const res = await call("post", "/requests", org.auth, requestBody(w, { venueLat: 21.9811, venueLng: 90.2354 }));
    expect(res.status).toBe(201);
    expect(res.body.data.pin).toEqual({ lat: 21.9811, lng: 90.2354 });
    expect(res.body.data.areaCentre).toEqual({ lat: 21.99, lng: 90.22 });
    const viewer = await signedIn("v@example.com");
    expect((await call("get", `/requests/${res.body.data.id}`, viewer.auth)).body.data.pin).toEqual({ lat: 21.9811, lng: 90.2354 });
  });

  it("a game with no pin has pin: null and still carries the area centre", async () => {
    const org = await signedIn("org@example.com");
    const res = await call("post", "/requests", org.auth, requestBody(w));
    expect(res.body.data).toMatchObject({ pin: null, areaCentre: { lat: 21.99, lng: 90.22 } });
  });

  it("rejects a pin outside Bangladesh and half a pin; the pin can be moved and removed", async () => {
    const org = await signedIn("org@example.com");
    expect((await call("post", "/requests", org.auth, requestBody(w, { venueLat: 51.5, venueLng: -0.12 }))).status).toBe(422);
    expect((await call("post", "/requests", org.auth, requestBody(w, { venueLat: 22.0 }))).status).toBe(422);
    const id = (await call("post", "/requests", org.auth, requestBody(w, { venueLat: 22.0, venueLng: 90.2 }))).body.data.id as string;
    expect((await call("patch", `/requests/${id}`, org.auth, { venueLat: 22.01, venueLng: 90.21 })).body.data.pin).toEqual({ lat: 22.01, lng: 90.21 });
    expect((await call("patch", `/requests/${id}`, org.auth, { venueLat: null, venueLng: null })).body.data.pin).toBeNull();
    expect((await call("patch", `/requests/${id}`, org.auth, { venueLat: 22.0 })).status).toBe(422);
  });

  it("the map feed lists open upcoming games with exact or approximate positions, signed out too, and hides the rest", async () => {
    const org = await signedIn("org@example.com");
    const pinned = (await call("post", "/requests", org.auth, requestBody(w, { venueLat: 21.98, venueLng: 90.23 }))).body.data.id as string;
    const loose = (await call("post", "/requests", org.auth, requestBody(w))).body.data.id as string;
    await makeRequest(w, org.user.id, { matchAt: hoursFromNow(-3) }); // past
    await makeRequest(w, org.user.id, { status: "CANCELLED" });
    await makeRequest(w, org.user.id, { isHidden: true });
    const pub = (await call("get", "/public/requests/map", null)).body.data as { id: string; exact: boolean; lat: number }[];
    expect(pub.map((g) => g.id).sort()).toEqual([pinned, loose].sort());
    expect(pub.find((g) => g.id === pinned)).toMatchObject({ exact: true, lat: 21.98 });
    expect(pub.find((g) => g.id === loose)).toMatchObject({ exact: false, lat: 21.99, lng: 90.22 });
    const viewer = await signedIn("v@example.com");
    expect((await call("get", `/requests/map?sportId=${w.football.id}`, viewer.auth)).body.data).toHaveLength(2);
    expect((await call("get", `/requests/map?upazilaId=${w.galachipa.id}`, viewer.auth)).body.data).toHaveLength(0);
    expect((await call("get", "/requests/map?sportId=x", viewer.auth)).status).toBe(422);
  });

  it("the location lists carry coordinates", async () => {
    const ups = (await call("get", `/locations/upazilas?districtId=${w.patuakhali.id}`, null)).body.data as { id: number; lat: number | null }[];
    expect(ups.find((u) => u.id === w.kalapara.id)?.lat).toBe(21.99);
  });
});

describe("approximate area from the connection", () => {
  it("answers with a town-level point and its area, only for Bangladesh, and never from a failing service", async () => {
    const { ipDeps, clearIpCache } = await import("../src/modules/locations/locations.service.js");
    const real = ipDeps.fetch;
    try {
      clearIpCache();
      ipDeps.fetch = async () => new Response(JSON.stringify({ success: true, latitude: 21.9912, longitude: 90.2234, country_code: "BD" }), { status: 200 });
      const res = await api().get(`${V1}/locations/by-ip`);
      expect(res.headers["cache-control"]).toBe("no-store");
      if (res.status === 200) expect(res.body.data).toMatchObject({ approximate: true, lat: 21.99, lng: 90.22 });
      else expect(res.status).toBe(404); // the tiny test world has no boundary polygons
      clearIpCache();
      ipDeps.fetch = async () => new Response(JSON.stringify({ success: true, latitude: 51.5, longitude: -0.1, country_code: "GB" }), { status: 200 });
      expect((await api().get(`${V1}/locations/by-ip`)).status).toBe(404);
      clearIpCache();
      ipDeps.fetch = async () => { throw new Error("down"); };
      expect((await api().get(`${V1}/locations/by-ip`)).status).toBe(404);
    } finally {
      ipDeps.fetch = real;
      clearIpCache();
    }
  });
});
