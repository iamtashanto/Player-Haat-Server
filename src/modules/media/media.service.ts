import { AppError } from "../../lib/errors.js";
import { newPublicId, isOwnedBy } from "../../lib/storage/paths.js";
import { storage, type ImageKind } from "../../lib/storage/index.js";
import { prisma } from "../../lib/prisma.js";

export interface UploadedImage {
  url: string;
  publicId: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/** Uploads into the caller's own namespace; the id is generated here, never chosen by the client. */
export function uploadOwnedImage(userId: string, kind: ImageKind, buffer: Buffer): Promise<UploadedImage> {
  return storage.uploadImage(buffer, { kind, publicId: newPublicId(kind, userId) });
}

/** Deletes an upload that isn't attached to anything. Refuses other users' images and live ones. */
export async function deleteOwnedImage(userId: string, publicId: string): Promise<void> {
  if (!isOwnedBy(userId, publicId)) throw AppError.forbidden("MEDIA_NOT_OWNED", "That image is not yours");

  const [asAvatar, asPhoto, asEvidence] = await Promise.all([
    prisma.user.findFirst({ where: { avatarPublicId: publicId }, select: { id: true } }),
    prisma.playerMedia.findFirst({ where: { publicId }, select: { id: true } }),
    prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "VerificationRequest" WHERE "evidenceImages" @> ${JSON.stringify([{ publicId }])}::jsonb LIMIT 1`,
  ]);
  if (asAvatar || asPhoto || asEvidence.length > 0) {
    throw AppError.conflict("MEDIA_IN_USE", "Remove the image from your profile first");
  }
  await storage.deleteImage(publicId);
}
