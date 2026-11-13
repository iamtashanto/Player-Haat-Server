import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, prisma, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

const search = (q: string, extra = "") => api().get(`${V1}/locations/search?q=${encodeURIComponent(q)}${extra}`);
type Hit = { level: string; id: number; nameEn: string; division: { id: number } | null; district: { id: number } | null; upazila: { id: number } | null };

describe("GET /locations/search: type any part of an address", () => {
  it("finds a union by its name and returns the whole chain so one tap fills the address", async () => {
    const res = await search("latachapli");
    expect(res.status).toBe(200);
    const hit: Hit = res.body.data[0];
    expect(hit).toMatchObject({ level: "union", id: w.latachapli.id });
    expect(hit.upazila?.id).toBe(w.kalapara.id);
    expect(hit.district?.id).toBe(w.patuakhali.id);
    expect(hit.division?.id).toBeTruthy();
  });

  it("matches in Bangla and in English, with any capitalisation and partial words", async () => {
    expect((await search("লতাচাপ")).body.data[0].id).toBe(w.latachapli.id);
    expect((await search("KALAP")).body.data[0]).toMatchObject({ level: "upazila", id: w.kalapara.id });
    expect((await search("patuakh")).body.data[0]).toMatchObject({ level: "district", id: w.patuakhali.id });
  });

  it("understands several words in any order, using the parent names", async () => {
    for (const q of ["latachapli kalapara", "kalapara latachapli", "latachapli, kalapara, patuakhali", "লতাচাপলী কলাপাড়া"]) {
      const hit: Hit = (await search(q)).body.data[0];
      expect(hit, q).toMatchObject({ level: "union", id: w.latachapli.id });
    }
    // a wrong parent narrows the result away instead of guessing
    expect((await search("latachapli savar")).body.data).toEqual([]);
  });

  it("a parent's name lists the places inside it, after the place itself", async () => {
    const data: Hit[] = (await search("kalapara")).body.data;
    expect(data[0]).toMatchObject({ level: "upazila", id: w.kalapara.id }); // its own name first
    expect(data.slice(1).map((h) => h.id).sort()).toEqual([w.latachapli.id, w.mohipur.id].sort()); // then its unions
  });

  it("can be limited to one level and to a number of results", async () => {
    const unions: Hit[] = (await search("kalapara", "&level=union")).body.data;
    expect(unions.every((h) => h.level === "union")).toBe(true);
    expect((await search("a", "&limit=2")).status).toBe(422); // one character is too short
    expect((await search("pa", "&limit=1")).body.data).toHaveLength(1);
  });

  it("returns nothing (not an error) when nothing matches, and rejects an empty or one-letter query", async () => {
    expect((await search("zzzzqq")).body.data).toEqual([]);
    expect((await search("")).status).toBe(422);
  });
});

describe("post codes", () => {
  it("a 4-digit code finds the upazila that has that post office, and results carry their post codes", async () => {
    await prisma.postOffice.createMany({ data: [{ upazilaId: w.kalapara.id, nameEn: "Kalapara", code: "8650" }, { upazilaId: w.kalapara.id, nameEn: "Mithaganj", code: "8651" }] });
    const byCode = (await search("8650")).body.data as { level: string; id: number; postcodes: { code: string; office: string }[] }[];
    expect(byCode[0]).toMatchObject({ level: "upazila", id: w.kalapara.id, postcodes: [{ code: "8650", office: "Kalapara" }, { code: "8651", office: "Mithaganj" }] });
    const byName = (await search("kalapara", "&level=upazila")).body.data as { id: number; postcodes: unknown[] }[];
    expect(byName.find((r) => r.id === w.kalapara.id)?.postcodes).toHaveLength(2);
    expect((await search("9999")).body.data).toEqual([]);
  });
});

describe("places (villages, towns, beaches)", () => {
  it("finds Kuakata by English or Bangla name and returns its upazila, district and kind", async () => {
    await prisma.place.createMany({ data: [
      { nameEn: "Kuakata", nameBn: "কুয়াকাটা", kind: "BEACH", lat: 21.82, lng: 90.12, districtId: w.patuakhali.id, upazilaId: w.kalapara.id },
      { nameEn: "Kuakata Bazar", nameBn: null, kind: "MARKET", lat: 21.81, lng: 90.11, districtId: w.patuakhali.id, upazilaId: w.kalapara.id },
      { nameEn: "Some Village", nameBn: null, kind: "VILLAGE", lat: 22.5, lng: 90.4, districtId: w.dhaka.id, upazilaId: w.savar.id },
    ] });
    const en = (await search("kuakata")).body.data as { level: string; nameEn: string; kind?: string; upazila: { id: number } | null; district: { id: number } | null }[];
    expect(en[0]).toMatchObject({ level: "place", nameEn: "Kuakata", kind: "BEACH", upazila: { id: w.kalapara.id }, district: { id: w.patuakhali.id } });
    expect(en.map((r) => r.nameEn)).toEqual(["Kuakata", "Kuakata Bazar"]);
    const bn = (await search("কুয়াকাটা")).body.data as { nameEn: string }[];
    expect(bn[0]?.nameEn).toBe("Kuakata");
    // a place can be found through its parents too, and a plain upazila search still ranks the upazila first
    const byParent = (await search("kuakata kalapara")).body.data as { nameEn: string }[];
    expect(byParent.map((r) => r.nameEn)).toContain("Kuakata");
    expect(((await search("kalapara")).body.data as { level: string }[])[0]?.level).toBe("upazila");
    // restricting the level excludes places
    expect(((await search("kuakata", "&level=union")).body.data as unknown[]).length).toBe(0);
    expect(((await search("kuakata", "&level=place")).body.data as unknown[]).length).toBe(2);
  });
});
