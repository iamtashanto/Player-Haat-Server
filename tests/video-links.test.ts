import { describe, expect, it } from "vitest";
import { parseVideoLink } from "../src/lib/video-links.js";

describe("parseVideoLink", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "YOUTUBE", "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtu.be/dQw4w9WgXcQ", "YOUTUBE", "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.facebook.com/watch/?v=123456789012345&ref=share", "FACEBOOK", "123456789012345", "https://www.facebook.com/watch/?v=123456789012345"],
    ["https://m.facebook.com/kalaparafc/videos/987654321098765/?extra=1", "FACEBOOK", "987654321098765", "https://www.facebook.com/kalaparafc/videos/987654321098765"],
    ["https://www.facebook.com/reel/1122334455667788", "FACEBOOK", "1122334455667788", "https://www.facebook.com/reel/1122334455667788"],
    ["https://fb.watch/AbCdEfGh1/", "FACEBOOK", "AbCdEfGh1", "https://fb.watch/AbCdEfGh1/"],
    ["https://www.instagram.com/reel/C8aBcDeFgHi/?igsh=xyz", "INSTAGRAM", "C8aBcDeFgHi", "https://www.instagram.com/reel/C8aBcDeFgHi/"],
    ["https://instagram.com/p/Cx1AbCdEf/", "INSTAGRAM", "Cx1AbCdEf", "https://www.instagram.com/p/Cx1AbCdEf/"],
    ["https://www.tiktok.com/@rakib.fc/video/7301234567890123456?lang=en", "TIKTOK", "7301234567890123456", "https://www.tiktok.com/@rakib.fc/video/7301234567890123456"],
    ["https://vm.tiktok.com/ZSabc123/", "TIKTOK", "ZSabc123", "https://vm.tiktok.com/ZSabc123/"],
  ])("reads %s", (input, source, id, url) => {
    expect(parseVideoLink(input)).toMatchObject({ source, videoId: id, url });
  });

  it("gives YouTube a thumbnail and the others none", () => {
    expect(parseVideoLink("dQw4w9WgXcQ")?.thumbnailUrl).toContain("img.youtube.com/vi/dQw4w9WgXcQ");
    expect(parseVideoLink("https://www.instagram.com/reel/C8aBcDeFgHi/")?.thumbnailUrl).toBeNull();
  });

  it.each([
    "https://evil.com/watch?v=dQw4w9WgXcQ",
    "https://facebook.com.evil.com/reel/1122334455667788",
    "https://www.facebook.com/kalaparafc", // a page, not a video
    "https://www.instagram.com/rakib/", // a profile
    "https://www.tiktok.com/@rakib", // a profile
    "https://www.tiktok.com/@rakib/video/notanumber",
    "javascript:alert(1)",
    "ftp://www.facebook.com/reel/1122334455667788",
    "https://vimeo.com/123456",
    "",
    "   ",
  ])("rejects %s", (input) => expect(parseVideoLink(input)).toBeNull());
});
