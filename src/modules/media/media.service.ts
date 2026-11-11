import { AppError } from "../../lib/errors.js";
import { newPublicId, isOwnedBy } from "../../lib/storage/paths.js";
import { storage, type ImageKind } from "../../lib/storage/index.js";
import { prisma } from "../../lib/prisma.js";
import { sniffImageType } from "../../lib/image-sniff.js";
import { stripImageMetadata } from "../../lib/image-meta.js";

export interface UploadedImage {
  url: string;
  publicId: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/** Remembers the facts about an upload (media id, mime, size, pixels) so screens can reserve its space. */
export async function recordAsset(image: { publicId: string; mediaId?: string; mime?: string; width?: number; height?: number; bytes?: number }, mime: string) {
  const data = { mediaId: image.mediaId ?? null, mime: image.mime ?? mime, width: image.width ?? null, height: image.height ?? null, size: image.bytes ?? null };
  await prisma.mediaAsset.upsert({ where: { path: image.publicId }, create: { path: image.publicId, ...data }, update: data });
}

/** Uploads into the caller's own namespace; the id is generated here, never chosen by the client. */
export async function uploadOwnedImage(userId: string, kind: ImageKind, buffer: Buffer): Promise<UploadedImage> {
  // Location (EXIF GPS) and other embedded metadata never reach storage.
  const mime = sniffImageType(buffer);
  const clean = mime ? stripImageMetadata(buffer, mime) : buffer;
  const image = await storage.uploadImage(clean, { kind, publicId: newPublicId(kind, userId) });
  await recordAsset(image, mime ?? "image/jpeg");
  return image;
}

/** Deletes an upload that isn't attached to anything. Refuses other users' images and live ones. */
export async function deleteOwnedImage(userId: string, publicId: string): Promise<void> {
  if (!isOwnedBy(userId, publicId)) throw AppError.forbidden("MEDIA_NOT_OWNED", "That image is not yours");

  const [asAvatar, asPhoto, asEvidence, asCover, asOrgLogo] = await Promise.all([
    prisma.user.findFirst({ where: { avatarPublicId: publicId }, select: { id: true } }),
    prisma.playerMedia.findFirst({ where: { publicId }, select: { id: true } }),
    prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "VerificationRequest" WHERE "evidenceImages" @> ${JSON.stringify([{ publicId }])}::jsonb LIMIT 1`,
    prisma.playerProfile.findFirst({ where: { coverPublicId: publicId }, select: { id: true } }),
    prisma.recruiterProfile.findFirst({ where: { logoPublicId: publicId }, select: { id: true } }),
  ]);
  if (asAvatar || asPhoto || asCover || asOrgLogo || asEvidence.length > 0) {
    throw AppError.conflict("MEDIA_IN_USE", "Remove the image from your profile first");
  }
  await storage.deleteImage(publicId);
}
