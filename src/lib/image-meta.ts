import type { ImageMime } from "./image-sniff.js";

/**
 * Removes location and other embedded metadata before an image is stored or shown to anyone.
 * Phone photos carry GPS coordinates in EXIF; publishing those would reveal where a player lives.
 *
 * - JPEG: drops APP1 (EXIF, XMP), APP13 (Photoshop/IPTC) and comment segments. Orientation is the one EXIF
 *   field that matters for display, so it is applied by clients before upload (and the pixels are untouched here).
 * - PNG: drops eXIf, tEXt, zTXt and iTXt chunks.
 * - WebP: drops EXIF and XMP chunks and clears their flags.
 * - HEIC: not rewritten (the metadata lives inside the container's item tables). Clients convert to JPEG.
 *
 * Lenient by design: a structure that can't be parsed is returned unchanged rather than corrupted.
 */
export function stripImageMetadata(buf: Buffer, mime: ImageMime): Buffer {
  try {
    if (mime === "image/jpeg") return stripJpeg(buf);
    if (mime === "image/png") return stripPng(buf);
    if (mime === "image/webp") return stripWebp(buf);
  } catch {
    /* fall through: unparseable → unchanged */
  }
  return buf;
}

function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf; // not a marker: leave the file alone
    const marker = buf[i + 1]!;
    if (marker === 0xda) {
      out.push(buf.subarray(i)); // start of scan: the rest is entropy-coded image data
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);
function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return buf;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

function stripWebp(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > buf.length + 1) return buf;
    let chunk = buf.subarray(i, Math.min(end, buf.length));
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      i = end;
      continue;
    }
    if (fourcc === "VP8X") {
      chunk = Buffer.from(chunk);
      chunk[8] = chunk[8]! & ~(0x08 | 0x04); // clear the EXIF and XMP flags
    }
    out.push(chunk);
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "ascii");
  return Buffer.concat([head, body]);
}
