import { parseYouTubeId, youtubeThumbnail, youtubeWatchUrl } from "./youtube.js";

/**
 * Video links people can add to a profile: YouTube, Facebook, Instagram, TikTok. Only https links to these sites are
 * accepted and the stored link is rebuilt from the parts we parsed, never the raw input, so tracking parameters, other
 * hosts and look-alike domains never get through.
 */
export type VideoProvider = "YOUTUBE" | "FACEBOOK" | "INSTAGRAM" | "TIKTOK";

export interface ParsedVideo {
  source: VideoProvider;
  /** The id (or short code) on that site: used to spot duplicates. */
  videoId: string;
  /** The clean link people open. */
  url: string;
  thumbnailUrl: string | null;
}

const host = (h: string) => h.toLowerCase().replace(/^(www|m|web|mobile|l)\./, "");
const FB_HOSTS = new Set(["facebook.com", "fb.com", "fb.watch"]);
const IG_HOSTS = new Set(["instagram.com", "instagr.am"]);
const TT_HOSTS = new Set(["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);
const FB_ID = /^[A-Za-z0-9._-]{4,80}$/;
const IG_CODE = /^[A-Za-z0-9_-]{5,20}$/;
const TT_ID = /^\d{8,25}$/;
const TT_SHORT = /^[A-Za-z0-9]{5,20}$/;

function toUrl(input: string): URL | null {
  const raw = input.trim();
  if (!raw || raw.length > 500) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function parseFacebook(u: URL): ParsedVideo | null {
  const h = host(u.hostname);
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (h === "fb.watch") id = parts[0];
  else if (parts[0] === "watch") id = u.searchParams.get("v") ?? undefined;
  else if (parts[0] === "reel" || parts[0] === "reels") id = parts[1];
  else if (parts[0] === "share" && (parts[1] === "v" || parts[1] === "r" || parts[1] === "reel")) id = parts[2];
  else if (parts[1] === "videos" && parts[2]) id = parts[2];
  else if (parts[0] === "video.php") id = u.searchParams.get("v") ?? undefined;
  if (!id || !FB_ID.test(id)) return null;
  const url =
    h === "fb.watch" ? `https://fb.watch/${id}/`
    : parts[0] === "watch" || parts[0] === "video.php" ? `https://www.facebook.com/watch/?v=${id}`
    : parts[0] === "reel" || parts[0] === "reels" ? `https://www.facebook.com/reel/${id}`
    : parts[0] === "share" ? `https://www.facebook.com/share/${parts[1]}/${id}/`
    : `https://www.facebook.com/${encodeURIComponent(parts[0]!)}/videos/${id}`;
  return { source: "FACEBOOK", videoId: id, url, thumbnailUrl: null };
}

function parseInstagram(u: URL): ParsedVideo | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const [kind, code] = parts[0] === "reels" ? ["reel", parts[1]] : [parts[0], parts[1]];
  if (!["reel", "p", "tv"].includes(kind ?? "") || !code || !IG_CODE.test(code)) return null;
  return { source: "INSTAGRAM", videoId: code, url: `https://www.instagram.com/${kind}/${code}/`, thumbnailUrl: null };
}

function parseTikTok(u: URL): ParsedVideo | null {
  const h = host(u.hostname);
  const parts = u.pathname.split("/").filter(Boolean);
  if (h === "vm.tiktok.com" || h === "vt.tiktok.com") {
    const code = parts[0];
    return code && TT_SHORT.test(code) ? { source: "TIKTOK", videoId: code, url: `https://${h}/${code}/`, thumbnailUrl: null } : null;
  }
  if (parts[0] === "t" && parts[1] && TT_SHORT.test(parts[1])) return { source: "TIKTOK", videoId: parts[1], url: `https://www.tiktok.com/t/${parts[1]}/`, thumbnailUrl: null };
  const user = parts[0];
  if (user?.startsWith("@") && /^@[A-Za-z0-9._]{1,40}$/.test(user) && parts[1] === "video" && parts[2] && TT_ID.test(parts[2])) {
    return { source: "TIKTOK", videoId: parts[2], url: `https://www.tiktok.com/${user}/video/${parts[2]}`, thumbnailUrl: null };
  }
  return null;
}

export function parseVideoLink(input: string): ParsedVideo | null {
  const yt = parseYouTubeId(input);
  if (yt) return { source: "YOUTUBE", videoId: yt, url: youtubeWatchUrl(yt), thumbnailUrl: youtubeThumbnail(yt) };
  const u = toUrl(input);
  if (!u) return null;
  const h = host(u.hostname);
  if (FB_HOSTS.has(h)) return parseFacebook(u);
  if (IG_HOSTS.has(h)) return parseInstagram(u);
  if (TT_HOSTS.has(h)) return parseTikTok(u);
  return null;
}
