import { beforeEach, describe, expect, it } from "vitest";
import { V1, api, resetDb, seedWorld, type World } from "./helpers.js";

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
