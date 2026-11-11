import { beforeEach, describe, expect, it } from "vitest";
import { fakeStorage } from "./fake-storage.js";
import { V1, api, makePlayer, prisma, resetDb, seedWorld, signedIn, type World } from "./helpers.js";
import { HEIC, JPEG, NOT_AN_IMAGE, PNG, bigImage } from "./images.js";

type Auth = Record<string, string>;
let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const get = (a: Auth, path: string) => api().get(`${V1}${path}`).set(a);
const post = (a: Auth, path: string, body: object) => api().post(`${V1}${path}`).set(a).send(body);
const patch = (a: Auth, path: string, body: object) => api().patch(`${V1}${path}`).set(a).send(body);
const del = (a: Auth, path: string) => api().delete(`${V1}${path}`).set(a);
const loc = () => ({ districtId: w.patuakhali.id, upazilaId: w.kalapara.id });

async function withProfile(email = "me@example.com") {
  const s = await signedIn(email);
  const res = await post(s.auth, "/players/me", loc());
  expect(res.status).toBe(201);
  return s;
}

describe("player profile", () => {
  it("404s before a profile exists", async () => {
    const { auth } = await signedIn();
    const res = await get(auth, "/players/me");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PLAYER_PROFILE_NOT_FOUND");
  });

  it("creates a profile with location names and sensible defaults", async () => {
    const { auth } = await signedIn();
    const res = await post(auth, "/players/me", { ...loc(), unionId: w.latachapli.id, bio: "  Striker from Kuakata " });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Viewer",
      bio: "Striker from Kuakata",
      isVisible: true,
      hiddenByAdmin: false,
      rating: { average: 0, count: 0 },
      noShowCount: 0,
      verifiedBadge: false,
      location: {
        district: { nameEn: "Patuakhali" },
        upazila: { nameEn: "Kalapara", nameBn: "কলাপাড়া" },
        union: { nameEn: "Latachapli" },
      },
      sports: [],
      media: [],
    });
  });

  it("refuses a second profile", async () => {
    const { auth } = await withProfile();
    const res = await post(auth, "/players/me", loc());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PLAYER_PROFILE_EXISTS");
  });

  it.each([
    ["an upazila from another district", () => ({ districtId: w.dhaka.id, upazilaId: w.kalapara.id })],
    ["an unknown upazila", () => ({ districtId: w.patuakhali.id, upazilaId: 999_999 })],
    ["a union from another upazila", () => ({ ...loc(), upazilaId: w.galachipa.id, unionId: w.latachapli.id })],
    ["an unknown union", () => ({ ...loc(), unionId: 999_999 })],
  ])("rejects %s with LOCATION_INVALID", async (_label, body) => {
    const { auth } = await signedIn();
    const res = await post(auth, "/players/me", body());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LOCATION_INVALID");
  });

  it("ignores no client-controlled reputation or moderation fields (422 on them)", async () => {
    const { auth } = await signedIn();
    for (const extra of [{ avgRating: 5 }, { ratingCount: 99 }, { noShowCount: 0 }, { verifiedBadge: true }, { hiddenByAdminAt: null }, { userId: "x" }]) {
      expect((await post(auth, "/players/me", { ...loc(), ...extra })).status).toBe(422);
    }
    expect((await get(auth, "/players/me")).status).toBe(404);
  });

  it("updates bio and visibility", async () => {
    const { auth } = await withProfile();
    const res = await patch(auth, "/players/me", { bio: "New bio", isVisible: false });
    expect(res.body.data).toMatchObject({ bio: "New bio", isVisible: false });
    expect((await patch(auth, "/players/me", { bio: null })).body.data.bio).toBeNull();
  });

  it("requires district and upazila to change together, and re-validates the nesting", async () => {
    const { auth } = await withProfile();
    expect((await patch(auth, "/players/me", { upazilaId: w.galachipa.id })).status).toBe(422);
    expect((await patch(auth, "/players/me", { districtId: w.dhaka.id, upazilaId: w.galachipa.id })).body.error.code).toBe("LOCATION_INVALID");
    expect((await patch(auth, "/players/me", {})).status).toBe(422);
  });

  it("moving upazila drops the old union; setting a valid union works", async () => {
    const { auth } = await signedIn();
    await post(auth, "/players/me", { ...loc(), unionId: w.latachapli.id });
    const moved = await patch(auth, "/players/me", { districtId: w.patuakhali.id, upazilaId: w.galachipa.id });
    expect(moved.body.data.location).toMatchObject({ upazila: { nameEn: "Galachipa" }, union: null });
    const back = await patch(auth, "/players/me", { districtId: w.patuakhali.id, upazilaId: w.kalapara.id, unionId: w.mohipur.id });
    expect(back.body.data.location.union.nameEn).toBe("Mohipur");
    expect((await patch(auth, "/players/me", { unionId: null })).body.data.location.union).toBeNull();
  });

  it("an admin-hidden profile stays hidden even if the player turns visibility back on", async () => {
    const owner = await withProfile("owner@example.com");
    const viewer = await signedIn("viewer@example.com");
    const profileId = (await prisma.playerProfile.findFirstOrThrow()).id;
    await prisma.playerProfile.update({ where: { id: profileId }, data: { hiddenByAdminAt: new Date() } });

    const res = await patch(owner.auth, "/players/me", { isVisible: true });
    expect(res.body.data).toMatchObject({ isVisible: true, hiddenByAdmin: true });
    expect((await get(viewer.auth, `/players/${profileId}`)).status).toBe(404);
    expect((await get(viewer.auth, "/players")).body.data).toEqual([]);
  });
});

describe("public profile", () => {
  it("shows what others should see and none of what they shouldn't", async () => {
    const owner = await withProfile("owner@example.com");
    await prisma.user.updateMany({ where: { email: "owner@example.com" }, data: { phone: "+8801712345678", birthYear: 1999 } });
    await post(owner.auth, "/players/me/sports", { sportId: w.football.id, positions: ["GK"], skillLevel: 4, preferredFoot: "LEFT" });
    const viewer = await signedIn("viewer@example.com");
    const id = (await prisma.playerProfile.findFirstOrThrow()).id;

    const res = await get(viewer.auth, `/players/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, name: "Viewer", sports: [{ sportCode: "FOOTBALL", preferredFoot: "LEFT" }] });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/owner@example\.com|8801712345678|birthYear|1999|passwordHash|userId|hiddenByAdminAt/);
    expect(res.body.data).not.toHaveProperty("isVisible");
  });

  it("404s for hidden, suspended, deleted and unknown profiles — indistinguishably", async () => {
    const viewer = await signedIn("viewer@example.com");
    const hidden = await makePlayer(w, { isVisible: false });
    const suspended = await makePlayer(w, { status: "SUSPENDED" });
    const deleted = await makePlayer(w, { status: "DELETED" });
    const bodies = [];
    for (const id of [hidden.profileId, suspended.profileId, deleted.profileId, "cknonexistent0000000000000"]) {
      const r = await get(viewer.auth, `/players/${id}`);
      expect(r.status).toBe(404);
      bodies.push(r.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("requires authentication", async () => {
    const p = await makePlayer(w);
    expect((await api().get(`${V1}/players/${p.profileId}`)).status).toBe(401);
  });
});

describe("player sports", () => {
  const football = () => ({ sportId: w.football.id, positions: ["GK"], skillLevel: 4 });

  it("needs a profile first", async () => {
    const { auth } = await signedIn();
    expect((await post(auth, "/players/me/sports", football())).status).toBe(404);
  });

  it("adds a sport with defaults, deduping positions", async () => {
    const { auth } = await withProfile();
    const res = await post(auth, "/players/me/sports", { ...football(), positions: ["GK", "ST", "GK"] });
    expect(res.status).toBe(201);
    expect(res.body.data.sports[0]).toMatchObject({
      sportCode: "FOOTBALL",
      positions: ["GK", "ST"],
      khepAvailable: false,
      rateMin: null,
      rateMax: null,
      travelRadius: "UPAZILA",
      availability: null,
    });
  });

  it("accepts khep with a rate range, foot for football, and availability — normalized", async () => {
    const { auth } = await withProfile();
    const res = await post(auth, "/players/me/sports", {
      ...football(),
      preferredFoot: "BOTH",
      khepAvailable: true,
      rateMin: 300,
      rateMax: 600,
      travelRadius: "DISTRICT",
      availability: { fri: ["evening", "evening", "afternoon"], sat: [], mon: ["morning"] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.sports[0]).toMatchObject({
      preferredFoot: "BOTH",
      khepAvailable: true,
      rateMin: 300,
      rateMax: 600,
      travelRadius: "DISTRICT",
      availability: { fri: ["evening", "afternoon"], mon: ["morning"] }, // empty day dropped, dup slot removed
    });
  });

  it.each([
    ["an unknown position", { positions: ["GOALIE"] }],
    ["another sport's position", { positions: ["BATTER"] }],
    ["too many positions", { positions: ["GK", "CB", "CM", "ST", "GK2"] }],
    ["no positions", { positions: [] }],
    ["batting style on football", { battingStyle: "LEFT_HAND" }],
    ["rates without khep", { rateMin: 100 }],
    ["rateMin above rateMax", { khepAvailable: true, rateMin: 500, rateMax: 100 }],
    ["negative rate", { khepAvailable: true, rateMin: -1 }],
    ["skill 0", { skillLevel: 0 }],
    ["skill 6", { skillLevel: 6 }],
    ["an invalid weekday", { availability: { funday: ["morning"] } }],
    ["an invalid slot", { availability: { mon: ["midnight"] } }],
    ["an unknown field", { avgRating: 5 }],
  ])("rejects %s", async (_label, extra) => {
    const { auth } = await withProfile();
    const res = await post(auth, "/players/me/sports", { ...football(), ...extra });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect((await get(auth, "/players/me")).body.data.sports).toEqual([]);
  });

  it("rejects foot on cricket, an inactive sport and an unknown sport", async () => {
    const { auth } = await withProfile();
    const cricket = { sportId: w.cricket.id, positions: ["BATTER"], skillLevel: 3 };
    expect((await post(auth, "/players/me/sports", { ...cricket, preferredFoot: "LEFT" })).status).toBe(422);
    expect((await post(auth, "/players/me/sports", { ...cricket, battingStyle: "LEFT_HAND" })).status).toBe(201);
    expect((await post(auth, "/players/me/sports", { sportId: w.badminton.id, positions: ["X"], skillLevel: 1 })).status).toBe(422);
    expect((await post(auth, "/players/me/sports", { sportId: 999_999, positions: ["X"], skillLevel: 1 })).status).toBe(422);
  });

  it("refuses to add the same sport twice", async () => {
    const { auth } = await withProfile();
    await post(auth, "/players/me/sports", football());
    const res = await post(auth, "/players/me/sports", football());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PLAYER_SPORT_EXISTS");
  });

  it("updates a sport by merging and re-validating the result", async () => {
    const { auth } = await withProfile();
    await post(auth, "/players/me/sports", { ...football(), khepAvailable: true, rateMin: 300, rateMax: 500 });
    const res = await patch(auth, `/players/me/sports/${w.football.id}`, { skillLevel: 5, positions: ["ST", "CM"] });
    expect(res.body.data.sports[0]).toMatchObject({ skillLevel: 5, positions: ["ST", "CM"], rateMin: 300, rateMax: 500, khepAvailable: true });

    expect((await patch(auth, `/players/me/sports/${w.football.id}`, { rateMax: 100 })).status).toBe(422); // now < rateMin
    expect((await patch(auth, `/players/me/sports/${w.football.id}`, { positions: ["BATTER"] })).status).toBe(422);
    expect((await patch(auth, `/players/me/sports/${w.football.id}`, {})).status).toBe(422);
  });

  it("turning khep off clears the rates; turning it on later needs new ones to be set", async () => {
    const { auth } = await withProfile();
    await post(auth, "/players/me/sports", { ...football(), khepAvailable: true, rateMin: 300, rateMax: 500 });
    const off = await patch(auth, `/players/me/sports/${w.football.id}`, { khepAvailable: false });
    expect(off.body.data.sports[0]).toMatchObject({ khepAvailable: false, rateMin: null, rateMax: null });
    const on = await patch(auth, `/players/me/sports/${w.football.id}`, { khepAvailable: true, rateMin: 200 });
    expect(on.body.data.sports[0]).toMatchObject({ khepAvailable: true, rateMin: 200, rateMax: null });
  });

  it("can clear availability and foot with null", async () => {
    const { auth } = await withProfile();
    await post(auth, "/players/me/sports", { ...football(), preferredFoot: "LEFT", availability: { mon: ["morning"] } });
    const res = await patch(auth, `/players/me/sports/${w.football.id}`, { preferredFoot: null, availability: null });
    expect(res.body.data.sports[0]).toMatchObject({ preferredFoot: null, availability: null });
  });

  it("removes a sport, and 404s for one that isn't there", async () => {
    const { auth } = await withProfile();
    await post(auth, "/players/me/sports", football());
    const res = await del(auth, `/players/me/sports/${w.football.id}`);
    expect(res.body.data.sports).toEqual([]);
    expect((await del(auth, `/players/me/sports/${w.football.id}`)).body.error.code).toBe("PLAYER_SPORT_NOT_FOUND");
    expect((await patch(auth, `/players/me/sports/${w.cricket.id}`, { skillLevel: 2 })).status).toBe(404);
  });

  it("only ever touches my own sports", async () => {
    const a = await withProfile("a@example.com");
    const b = await withProfile("b@example.com");
    await post(a.auth, "/players/me/sports", football());
    expect((await patch(b.auth, `/players/me/sports/${w.football.id}`, { skillLevel: 1 })).status).toBe(404);
    expect((await get(a.auth, "/players/me")).body.data.sports[0].skillLevel).toBe(4);
  });
});

describe("player media", () => {
  const photo = (a: Auth, buf = JPEG, type = "image/jpeg") =>
    api().post(`${V1}/players/me/media/photos`).set(a).attach("file", buf, { filename: "p.jpg", contentType: type });
  const cover = (a: Auth, buf = JPEG, type = "image/jpeg") =>
    api().put(`${V1}/players/me/media/cover`).set(a).attach("file", buf, { filename: "c.jpg", contentType: type });
  const video = (a: Auth, url: string, extra: object = {}) => post(a, "/players/me/media/videos", { sportId: w.football.id, url, ...extra });
  async function withFootball(email = "me@example.com") {
    const s = await withProfile(email);
    expect((await post(s.auth, "/players/me/sports", { sportId: w.football.id, positions: ["GK"], skillLevel: 3, preferredFoot: "RIGHT" })).status).toBe(201);
    return s;
  }
  const YT = (n: number) => `https://youtu.be/${String(n).padStart(11, "x")}`;

  it("needs a profile first", async () => {
    const { auth } = await signedIn();
    expect((await photo(auth)).status).toBe(404);
    expect((await cover(auth)).status).toBe(404);
    expect((await video(auth, YT(1))).status).toBe(404);
  });

  it("adds photos in my namespace, in order, with renditions, and records the public id", async () => {
    const { auth, user } = await withProfile();
    await photo(auth);
    const res = await photo(auth, PNG, "image/png");
    expect(res.status).toBe(201);
    expect(res.body.data.media.map((m: { order: number }) => m.order)).toEqual([0, 1]);
    expect(res.body.data.media[0]).toMatchObject({ type: "PHOTO", caption: null, source: null, videoId: null, sportId: null });
    expect(res.body.data.media[0].thumbnailUrl).toContain("/w_400/");
    const rows = await prisma.playerMedia.findMany({ orderBy: { order: "asc" } });
    expect(rows.every((r) => r.publicId!.includes(`/player-photos/${user.id}/`))).toBe(true);
    expect(rows.every((r) => fakeStorage.files.has(r.publicId!))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("publicId");
  });

  it("accepts heic and rejects non-images, spoofed content and oversize files", async () => {
    const { auth } = await withProfile();
    expect((await photo(auth, HEIC, "image/heic")).status).toBe(201);
    expect((await photo(auth, NOT_AN_IMAGE)).status).toBe(415);
    expect((await photo(auth, JPEG, "text/plain")).status).toBe(415);
    expect((await photo(auth, bigImage(5 * 1024 * 1024 + 2048))).status).toBe(413);
    expect(fakeStorage.files.size).toBe(1);
  });

  it("caps the gallery at 12 photos without uploading the rejected one", async () => {
    const { auth } = await withProfile();
    for (let i = 0; i < 12; i++) expect((await photo(auth)).status).toBe(201);
    const res = await photo(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PLAYER_MEDIA_LIMIT");
    expect(fakeStorage.files.size).toBe(12);
  });

  it("can't be pushed past the cap by concurrent uploads, and cleans up the losers", async () => {
    const { auth } = await withProfile();
    for (let i = 0; i < 10; i++) await photo(auth);
    const results = await Promise.all([photo(auth), photo(auth), photo(auth), photo(auth)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await prisma.playerMedia.count()).toBe(12);
    expect(fakeStorage.files.size).toBe(12); // losers' uploads were deleted
  });

  it("surfaces a storage outage as 502 and creates nothing", async () => {
    const { auth } = await withProfile();
    fakeStorage.failUploads = true;
    expect((await photo(auth)).status).toBe(502);
    expect((await cover(auth)).status).toBe(502);
    expect(await prisma.playerMedia.count()).toBe(0);
  });

  it("strips EXIF/XMP/comment segments (GPS) from jpeg uploads before they are stored", async () => {
    const { auth } = await withProfile();
    const seg = (marker: number, payload: string) => {
      const body = Buffer.from(payload, "latin1");
      return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
    };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe0, "JFIF\0\x01\x01"),
      seg(0xe1, "Exif\0\0GPSLatitude=22.3569;GPSLongitude=91.7832"),
      seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"),
      seg(0xfe, "taken at home"),
      seg(0xdb, "quantisation"),
      Buffer.from([0xff, 0xda, 0, 4, 1, 2, 0xaa, 0xbb, 0xff, 0xd9]),
    ]);
    expect((await photo(auth, jpeg)).status).toBe(201);
    const stored = [...fakeStorage.bytes.values()][0]!;
    expect(stored.toString("latin1")).not.toMatch(/GPSLatitude|xmpmeta|taken at home/);
    expect(stored.toString("latin1")).toContain("quantisation"); // the image itself is intact
    expect(stored.subarray(stored.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it("adds YouTube videos to a sports profile — any link form is stored as an id — max 6 per sport", async () => {
    const { auth } = await withFootball();
    const ID = "dQw4w9WgXcQ";
    for (const [i, url] of [`https://www.youtube.com/watch?v=${ID}&t=5s`, `https://youtu.be/${YT(2).slice(-11)}`, `https://youtube.com/shorts/${YT(3).slice(-11)}`, `https://www.youtube.com/embed/${YT(4).slice(-11)}`, YT(5).slice(-11), `https://m.youtube.com/watch?v=${YT(6).slice(-11)}`].entries()) {
      const res = await video(auth, url);
      expect(res.status, `${i} ${url}`).toBe(201);
    }
    const last = (await get(auth, "/players/me")).body.data.media;
    expect(last[0]).toMatchObject({ type: "VIDEO_LINK", source: "YOUTUBE", videoId: ID, sportId: w.football.id, url: `https://www.youtube.com/watch?v=${ID}`, thumbnailUrl: `https://img.youtube.com/vi/${ID}/hqdefault.jpg` });
    const over = await video(auth, YT(7));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("PLAYER_MEDIA_LIMIT");
  });

  it("rejects other sites and junk, duplicates, sports the player doesn't have, and UPLOAD (not available yet)", async () => {
    const { auth } = await withFootball();
    for (const bad of ["https://vimeo.com/123", "https://fb.watch/xyz", "https://evil.example.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/playlist?list=PL123", "javascript:alert(1)", "not a url", "https://youtu.be/short"]) {
      expect((await video(auth, bad)).status, bad).toBe(422);
    }
    expect((await video(auth, YT(1))).status).toBe(201);
    expect((await video(auth, YT(1))).body.error.code).toBe("PLAYER_MEDIA_DUPLICATE");
    expect((await post(auth, "/players/me/media/videos", { sportId: w.cricket.id, url: YT(2) })).status).toBe(404);
    const up = await video(auth, YT(3), { source: "UPLOAD" });
    expect(up.status).toBe(400);
    expect(up.body.error.code).toBe("UPLOAD_NOT_AVAILABLE");
    expect(await prisma.playerMedia.count()).toBe(1);
  });

  it("sets and clears a caption, only on my own media", async () => {
    const a = await withFootball("a@example.com");
    const b = await withFootball("b@example.com");
    await photo(a.auth);
    const m = await prisma.playerMedia.findFirstOrThrow();
    const set = await patch(a.auth, `/players/me/media/${m.id}`, { caption: "  Final, 2026  " });
    expect(set.body.data.media[0].caption).toBe("Final, 2026");
    expect((await patch(b.auth, `/players/me/media/${m.id}`, { caption: "mine now" })).status).toBe(404);
    expect((await patch(a.auth, `/players/me/media/${m.id}`, { caption: null })).body.data.media[0].caption).toBeNull();
    expect((await patch(a.auth, `/players/me/media/${m.id}`, { caption: "x".repeat(121) })).status).toBe(422);
  });

  it("sets a cover photo, replaces it (the old file is deleted), and removes it", async () => {
    const { auth, user } = await withProfile();
    expect((await get(auth, "/players/me")).body.data.coverUrl).toBeNull();
    const first = await cover(auth);
    expect(first.status).toBe(200);
    expect(first.body.data.coverUrl).toContain("/player-covers/" + user.id + "/");
    const oldId = (await prisma.playerProfile.findFirstOrThrow()).coverPublicId!;
    const second = await cover(auth, PNG, "image/png");
    expect(second.body.data.coverUrl).not.toBe(first.body.data.coverUrl);
    expect(fakeStorage.files.has(oldId)).toBe(false);
    expect(fakeStorage.files.size).toBe(1);
    const gone = await del(auth, "/players/me/media/cover");
    expect(gone.body.data.coverUrl).toBeNull();
    expect(fakeStorage.files.size).toBe(0);
    expect(JSON.stringify(second.body)).not.toContain("coverPublicId");
  });

  it("shows the cover, captions and videos on the public profile", async () => {
    const { auth } = await withFootball();
    await cover(auth);
    await photo(auth);
    await video(auth, YT(1), { caption: "Goal vs Rangpur" });
    const viewer = await signedIn("viewer@example.com");
    const pid = (await prisma.playerProfile.findFirstOrThrow()).id;
    const pub = (await get(viewer.auth, `/players/${pid}`)).body.data;
    expect(pub.coverUrl).toBeTruthy();
    expect(pub.media.map((m: { type: string }) => m.type)).toEqual(["PHOTO", "VIDEO_LINK"]);
    expect(pub.media[1].caption).toBe("Goal vs Rangpur");
  });

  it("removes a photo from the DB and from storage; a storage failure doesn't block removal", async () => {
    const { auth } = await withProfile();
    await photo(auth);
    await photo(auth);
    const [m1, m2] = await prisma.playerMedia.findMany({ orderBy: { order: "asc" } });

    const res = await del(auth, `/players/me/media/${m1!.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.media).toHaveLength(1);
    expect(fakeStorage.files.has(m1!.publicId!)).toBe(false);

    fakeStorage.failDeletes = true;
    expect((await del(auth, `/players/me/media/${m2!.id}`)).status).toBe(200);
    expect(await prisma.playerMedia.count()).toBe(0);
  });

  it("removing a video touches no storage; unknown/other users' media is 404", async () => {
    const a = await withFootball("a@example.com");
    const b = await withFootball("b@example.com");
    await video(a.auth, YT(1));
    const m = await prisma.playerMedia.findFirstOrThrow();
    expect((await del(b.auth, `/players/me/media/${m.id}`)).status).toBe(404);
    expect(await prisma.playerMedia.count()).toBe(1);
    expect((await del(a.auth, `/players/me/media/${m.id}`)).status).toBe(200);
    expect(fakeStorage.deleted).toEqual([]);
    expect((await del(a.auth, "/players/me/media/nope")).status).toBe(404);
  });

  it("reorders the gallery photos, and insists on the exact set of photo ids", async () => {
    const { auth } = await withFootball();
    await photo(auth);
    await video(auth, YT(1));
    await photo(auth);
    await photo(auth);
    const photos = (await prisma.playerMedia.findMany({ where: { type: "PHOTO" }, orderBy: { order: "asc" } })).map((m) => m.id);
    const [a, b, c] = photos as [string, string, string];

    const ok = await api().put(`${V1}/players/me/media/order`).set(auth).send({ ids: [c, a, b] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.media.filter((m: { type: string }) => m.type === "PHOTO").map((m: { id: string }) => m.id)).toEqual([c, a, b]);

    const videoId = (await prisma.playerMedia.findFirstOrThrow({ where: { type: "VIDEO_LINK" } })).id;
    for (const ids of [[a, b], [a, b, c, c], [a, b, "other"], [a, a, b], [a, b, c, videoId]]) {
      expect((await api().put(`${V1}/players/me/media/order`).set(auth).send({ ids })).status).toBe(422);
    }
  });
});
