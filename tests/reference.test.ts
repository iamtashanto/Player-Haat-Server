import { beforeEach, describe, expect, it } from "vitest";
import { sniffImageType } from "../src/lib/image-sniff.js";
import { normalizeBdPhone } from "../src/lib/phone.js";
import { HEIC, JPEG, NOT_AN_IMAGE, PNG, WEBP } from "./images.js";
import { V1, api, resetDb, seedWorld, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await seedWorld();
});

describe("locations", () => {
  it("walks the hierarchy division → district → upazila → union", async () => {
    const divisions = await api().get(`${V1}/locations/divisions`);
    expect(divisions.status).toBe(200);
    expect(divisions.body.data.map((d: { nameEn: string }) => d.nameEn)).toEqual(["Barishal", "Dhaka"]);

    const districts = await api().get(`${V1}/locations/districts?divisionId=${w.patuakhali.divisionId}`);
    expect(districts.body.data.map((d: { nameEn: string }) => d.nameEn)).toEqual(["Patuakhali"]);

    const upazilas = await api().get(`${V1}/locations/upazilas?districtId=${w.patuakhali.id}`);
    expect(upazilas.body.data.map((d: { nameEn: string }) => d.nameEn)).toEqual(["Galachipa", "Kalapara"]);

    const unions = await api().get(`${V1}/locations/unions?upazilaId=${w.kalapara.id}`);
    expect(unions.body.data).toHaveLength(2);
    expect(unions.body.data[0]).toMatchObject({ nameBn: "লতাচাপলী", upazilaId: w.kalapara.id });
  });

  it("requires the parent id and rejects junk", async () => {
    expect((await api().get(`${V1}/locations/districts`)).status).toBe(422);
    expect((await api().get(`${V1}/locations/upazilas?districtId=abc`)).status).toBe(422);
    expect((await api().get(`${V1}/locations/unions?upazilaId=-1`)).status).toBe(422);
  });

  it("returns an empty list for a parent with no children", async () => {
    const res = await api().get(`${V1}/locations/unions?upazilaId=${w.savar.id}`);
    expect(res.body.data).toEqual([]);
  });

  it("is cacheable (reference data)", async () => {
    const res = await api().get(`${V1}/locations/divisions`);
    expect(res.headers["cache-control"]).toContain("max-age=86400");
    expect(res.headers.etag).toBeTruthy();
  });

  it("searches by English name, case-insensitively, across levels with parents attached", async () => {
    const res = await api().get(`${V1}/locations/search?q=KALA`);
    expect(res.status).toBe(200);
    const hit = res.body.data.find((r: { nameEn: string }) => r.nameEn === "Kalapara");
    expect(hit).toMatchObject({ level: "upazila", district: { nameEn: "Patuakhali" } });
  });

  it("searches by Bangla name and can be limited to a level", async () => {
    const bn = await api().get(`${V1}/locations/search?q=${encodeURIComponent("মহিপুর")}`);
    expect(bn.body.data[0]).toMatchObject({
      level: "union",
      nameEn: "Mohipur",
      upazila: { nameEn: "Kalapara" },
      district: { nameEn: "Patuakhali" },
    });
    const onlyDistricts = await api().get(`${V1}/locations/search?q=dhaka&level=district`);
    expect(onlyDistricts.body.data.every((r: { level: string }) => r.level === "district")).toBe(true);
  });

  it("ranks prefix matches first and validates the query", async () => {
    const res = await api().get(`${V1}/locations/search?q=ala`); // Kalapara contains, Galachipa doesn't
    expect(res.body.data.map((r: { nameEn: string }) => r.nameEn)).toContain("Kalapara");
    expect((await api().get(`${V1}/locations/search?q=k`)).status).toBe(422);
    expect((await api().get(`${V1}/locations/search`)).status).toBe(422);
  });
});

describe("sports", () => {
  it("lists only active sports with ordered positions", async () => {
    const res = await api().get(`${V1}/sports`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { code: string }) => s.code)).toEqual(["FOOTBALL", "CRICKET"]); // BADMINTON inactive
    expect(res.body.data[0].positions.map((p: { code: string }) => p.code)).toEqual(["GK", "CB", "CM", "ST"]);
  });
});

describe("normalizeBdPhone", () => {
  it.each([
    ["01712345678", "+8801712345678"],
    ["+8801712345678", "+8801712345678"],
    ["8801712345678", "+8801712345678"],
    ["+880 1712-345678", "+8801712345678"],
    ["008801912345678", "+8801912345678"],
    ["(017) 1234 5678", "+8801712345678"],
  ])("%s → %s", (input, expected) => expect(normalizeBdPhone(input)).toBe(expected));

  it.each(["", "12345", "01212345678", "0171234567", "017123456789", "+44 7911 123456", "abc", "+8801712345678x"])(
    "rejects %j",
    (input) => expect(normalizeBdPhone(input)).toBeNull(),
  );
});

describe("sniffImageType", () => {
  it("identifies jpeg, png, webp and heic by content", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(HEIC)).toBe("image/heic");
  });
  it("rejects everything else, including tiny buffers and scripts", () => {
    expect(sniffImageType(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageType(Buffer.from("GIF89a......."))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7 ......"))).toBeNull();
  });
});
