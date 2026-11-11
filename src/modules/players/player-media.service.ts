import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { uploadOwnedImage } from "../media/media.service.js";
import { getMyProfile } from "./players.service.js";
import { parseYouTubeId, youtubeWatchUrl } from "../../lib/youtube.js";
import { MAX_PHOTOS, MAX_VIDEOS, type addVideoBody } from "./players.schema.js";
import type { z } from "zod";

async function profileIdOf(userId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Create your player profile first");
  return p.id;
}

/**
 * Appends a gallery photo inside a transaction that locks the profile, so two concurrent uploads
 * can't both slip past the limit.
 */
async function appendPhoto(profileId: string, data: { url: string; publicId: string }) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PlayerProfile" WHERE id = ${profileId} FOR UPDATE`;
    const [count, last] = await Promise.all([
      tx.playerMedia.count({ where: { profileId, type: "PHOTO" } }),
      tx.playerMedia.findFirst({ where: { profileId }, orderBy: { order: "desc" }, select: { order: true } }),
    ]);
    if (count >= MAX_PHOTOS) throw AppError.conflict("PLAYER_MEDIA_LIMIT", `You can have at most ${MAX_PHOTOS} photos`);
    await tx.playerMedia.create({ data: { profileId, type: "PHOTO", url: data.url, publicId: data.publicId, order: (last?.order ?? -1) + 1 } });
  });
}

export async function addPhoto(userId: string, buffer: Buffer) {
  const profileId = await profileIdOf(userId);
  const count = await prisma.playerMedia.count({ where: { profileId, type: "PHOTO" } });
  if (count >= MAX_PHOTOS) throw AppError.conflict("PLAYER_MEDIA_LIMIT", `You can have at most ${MAX_PHOTOS} photos`); // fail before uploading

  const image = await uploadOwnedImage(userId, "player-photo", buffer);
  try {
    await appendPhoto(profileId, { url: image.url, publicId: image.publicId });
  } catch (err) {
    await deleteImagesQuietly([image.publicId]); // lost the race or DB failed: don't orphan the upload
    throw err;
  }
  return getMyProfile(userId);
}

/** YouTube only for now. `source: UPLOAD` is reserved for our own hosting and answers UPLOAD_NOT_AVAILABLE. */
export async function addVideo(userId: string, input: z.infer<typeof addVideoBody>) {
  if (input.source === "UPLOAD") throw AppError.badRequest("UPLOAD_NOT_AVAILABLE", "Uploading videos isn't available yet. Add a YouTube link instead.");
  const videoId = parseYouTubeId(input.url);
  if (!videoId) throw AppError.invalid("url", "That isn't a YouTube video link");
  const profileId = await profileIdOf(userId);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PlayerProfile" WHERE id = ${profileId} FOR UPDATE`;
    const plays = await tx.playerSport.findUnique({ where: { profileId_sportId: { profileId, sportId: input.sportId } }, select: { id: true } });
    if (!plays) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "You haven't added that sport");
    const [count, last, dupe] = await Promise.all([
      tx.playerMedia.count({ where: { profileId, type: "VIDEO_LINK", sportId: input.sportId } }),
      tx.playerMedia.findFirst({ where: { profileId }, orderBy: { order: "desc" }, select: { order: true } }),
      tx.playerMedia.findFirst({ where: { profileId, type: "VIDEO_LINK", sportId: input.sportId, videoId }, select: { id: true } }),
    ]);
    if (dupe) throw AppError.conflict("PLAYER_MEDIA_DUPLICATE", "That video is already on this sports profile");
    if (count >= MAX_VIDEOS) throw AppError.conflict("PLAYER_MEDIA_LIMIT", `You can have at most ${MAX_VIDEOS} videos per sports profile`);
    await tx.playerMedia.create({
      data: { profileId, type: "VIDEO_LINK", url: youtubeWatchUrl(videoId), source: "YOUTUBE", videoId, sportId: input.sportId, caption: input.caption ?? null, order: (last?.order ?? -1) + 1 },
    });
  });
  return getMyProfile(userId);
}

export async function setCaption(userId: string, mediaId: string, caption: string | null) {
  const profileId = await profileIdOf(userId);
  const media = await prisma.playerMedia.findFirst({ where: { id: mediaId, profileId }, select: { id: true } });
  if (!media) throw AppError.notFound("PLAYER_MEDIA_NOT_FOUND", "Media not found");
  await prisma.playerMedia.update({ where: { id: media.id }, data: { caption: caption?.trim() || null } });
  return getMyProfile(userId);
}

/** Replaces the cover photo; the old file is deleted once the new one is saved. */
export async function setCover(userId: string, buffer: Buffer) {
  const profileId = await profileIdOf(userId);
  const old = await prisma.playerProfile.findUniqueOrThrow({ where: { id: profileId }, select: { coverPublicId: true } });
  const image = await uploadOwnedImage(userId, "player-cover", buffer);
  try {
    await prisma.playerProfile.update({ where: { id: profileId }, data: { coverUrl: image.url, coverPublicId: image.publicId } });
  } catch (err) {
    await deleteImagesQuietly([image.publicId]);
    throw err;
  }
  await deleteImagesQuietly([old.coverPublicId]);
  return getMyProfile(userId);
}

export async function removeCover(userId: string) {
  const profileId = await profileIdOf(userId);
  const old = await prisma.playerProfile.findUniqueOrThrow({ where: { id: profileId }, select: { coverPublicId: true } });
  await prisma.playerProfile.update({ where: { id: profileId }, data: { coverUrl: null, coverPublicId: null } });
  await deleteImagesQuietly([old.coverPublicId]);
  return getMyProfile(userId);
}

export async function removeMedia(userId: string, mediaId: string) {
  const profileId = await profileIdOf(userId);
  const media = await prisma.playerMedia.findFirst({ where: { id: mediaId, profileId } });
  if (!media) throw AppError.notFound("PLAYER_MEDIA_NOT_FOUND", "Media not found");
  await prisma.playerMedia.delete({ where: { id: media.id } });
  await deleteImagesQuietly([media.publicId]);
  return getMyProfile(userId);
}

export async function reorderMedia(userId: string, ids: string[]) {
  const profileId = await profileIdOf(userId);
  const existing = await prisma.playerMedia.findMany({ where: { profileId, type: "PHOTO" }, select: { id: true } });
  const have = new Set(existing.map((m) => m.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) {
    throw AppError.invalid("ids", "ids must list each of your gallery photos exactly once");
  }
  await prisma.$transaction(ids.map((id, order) => prisma.playerMedia.update({ where: { id }, data: { order } })));
  return getMyProfile(userId);
}

