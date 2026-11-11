import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "../src/lib/image-meta.js";
import { parseYouTubeId } from "../src/lib/youtube.js";

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]); // CRC isn't checked
};

describe("stripImageMetadata", () => {
  it("png: drops eXIf and text chunks, keeps the image chunks", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", Buffer.alloc(13, 1)),
      chunk("eXIf", Buffer.from("GPSLatitude")),
      chunk("tEXt", Buffer.from("Comment\0home")),
      chunk("IDAT", Buffer.from("pixels")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const out = stripImageMetadata(png, "image/png");
    expect(out.toString("latin1")).not.toMatch(/GPSLatitude|home/);
    expect(out.toString("latin1")).toContain("pixels");
    expect(out.toString("latin1")).toContain("IEND");
  });

  it("webp: drops EXIF and XMP chunks and clears their flags, with a consistent RIFF size", () => {
    const riffChunk = (id: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(id, 0, "ascii");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF + XMP + alpha
    const body = Buffer.concat([riffChunk("VP8X", vp8x), riffChunk("VP8 ", Buffer.from("pixels!!")), riffChunk("EXIF", Buffer.from("GPSLongitude")), riffChunk("XMP ", Buffer.from("<xmp/>"))]);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(body.length + 4, 4);
    head.write("WEBP", 8, "ascii");
    const out = stripImageMetadata(Buffer.concat([head, body]), "image/webp");
    expect(out.toString("latin1")).not.toMatch(/GPSLongitude|xmp/);
    expect(out.toString("latin1")).toContain("pixels!!");
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0); // EXIF and XMP flags cleared
    expect(out[20]! & 0x10).toBe(0x10); // alpha kept
  });

  it("leaves unparseable or unsupported input unchanged instead of corrupting it", () => {
    const junk = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]);
    expect(stripImageMetadata(junk, "image/jpeg").equals(junk)).toBe(true);
    const heic = Buffer.from("....ftypheic....");
    expect(stripImageMetadata(heic, "image/heic").equals(heic)).toBe(true);
  });
});

describe("parseYouTubeId", () => {
  const ID = "dQw4w9WgXcQ";
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?feature=share&v=${ID}&t=42s`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}?si=abc`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube.com/live/${ID}`],
    [`www.youtube.com/watch?v=${ID}`],
    [`  ${ID}  `],
  ])("reads the id from %s", (input) => expect(parseYouTubeId(input)).toBe(ID));

  it.each([
    ["https://vimeo.com/123456789"],
    ["https://www.youtube.com/playlist?list=PLabcdefghijk"],
    ["https://www.youtube.com/@channel"],
    ["https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"],
    ["https://evil.com/?u=https://youtu.be/dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=short"],
    ["javascript:alert(1)"],
    ["ftp://youtu.be/dQw4w9WgXcQ"],
    [""],
  ])("rejects %s", (input) => expect(parseYouTubeId(input)).toBeNull());
});
