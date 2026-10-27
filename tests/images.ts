/** Minimal byte sequences that pass magic-number sniffing (they need not be decodable images). */
const pad = (head: Buffer, size = 64) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 1)]);

export const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
export const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
export const WEBP = pad(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]));
export const HEIC = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic")]));
export const NOT_AN_IMAGE = Buffer.from("<?php system($_GET['c']); ?> definitely not an image");
export const bigImage = (bytes: number) => Buffer.concat([JPEG, Buffer.alloc(bytes - JPEG.length, 7)]);
