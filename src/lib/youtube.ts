const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"]);

/**
 * The 11-character video id from any YouTube link (watch, youtu.be, shorts, embed, live, with or without
 * extra query params) or from a bare id. Anything else — other sites, playlists, channels — is null.
 */
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (ID.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let candidate: string | undefined;
  if (u.hostname.toLowerCase() === "youtu.be") candidate = parts[0];
  else if (parts[0] === "watch") candidate = u.searchParams.get("v") ?? undefined;
  else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) candidate = parts[1];
  return candidate && ID.test(candidate) ? candidate : null;
}

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const youtubeThumbnail = (id: string) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
