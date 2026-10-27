import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { uploadOwnedImage } from "../media/media.service.js";
import { getMyProfile } from "./players.service.js";
import { MAX_PHOTOS, MAX_VIDEOS } from "./players.schema.js";

const limitFor = { PHOTO: MAX_PHOTOS, VIDEO_LINK: MAX_VIDEOS } as const;

async function profileIdOf(userId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Create your player profile first");
  return p.id;
}

/**
 * Appends a media row inside a transaction that locks the profile, so two concurrent uploads
 * can't both slip past the per-type limit.
 */
async function appendMedia(
  profileId: string,
  type: "PHOTO" | "VIDEO_LINK",
  data: { url: string; publicId?: string },
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PlayerProfile" WHERE id = ${profileId} FOR UPDATE`;
    const [count, last] = await Promise.all([
      tx.playerMedia.count({ where: { profileId, type } }),
      tx.playerMedia.findFirst({ where: { profileId }, orderBy: { order: "desc" }, select: { order: true } }),
    ]);
    if (count >= limitFor[type]) {
      throw AppError.conflict("PLAYER_MEDIA_LIMIT", `You can have at most ${limitFor[type]} ${type === "PHOTO" ? "photos" : "videos"}`);
    }
    await tx.playerMedia.create({
      data: { profileId, type, url: data.url, publicId: data.publicId ?? null, order: (last?.order ?? -1) + 1 },
    });
  });
}

export async function addPhoto(userId: string, buffer: Buffer) {
  const profileId = await profileIdOf(userId);
  const count = await prisma.playerMedia.count({ where: { profileId, type: "PHOTO" } });
  if (count >= MAX_PHOTOS) throw AppError.conflict("PLAYER_MEDIA_LIMIT", `You can have at most ${MAX_PHOTOS} photos`); // fail before uploading

  const image = await uploadOwnedImage(userId, "player-photo", buffer);
  try {
    await appendMedia(profileId, "PHOTO", { url: image.url, publicId: image.publicId });
  } catch (err) {
    await deleteImagesQuietly([image.publicId]); // lost the race or DB failed: don't orphan the upload
    throw err;
  }
  return getMyProfile(userId);
}

export async function addVideo(userId: string, url: string) {
  const profileId = await profileIdOf(userId);
  await appendMedia(profileId, "VIDEO_LINK", { url });
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
  const existing = await prisma.playerMedia.findMany({ where: { profileId }, select: { id: true } });
  const have = new Set(existing.map((m) => m.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) {
    throw AppError.invalid("ids", "ids must list each of your media items exactly once");
  }
  await prisma.$transaction(ids.map((id, order) => prisma.playerMedia.update({ where: { id }, data: { order } })));
  return getMyProfile(userId);
}

