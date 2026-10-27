import { Prisma, type User } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { uploadOwnedImage } from "../media/media.service.js";

type UserWithProfile = User & { playerProfile: { id: string } | null };

export function toMe(u: UserWithProfile) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerifiedAt !== null,
    phone: u.phone,
    phoneVerified: u.phoneVerifiedAt !== null,
    avatarUrl: u.avatarUrl,
    locale: u.locale,
    role: u.role,
    birthYear: u.birthYear,
    hasPlayerProfile: u.playerProfile !== null,
    captainRating: { average: u.captainAvgRating, count: u.captainRatingCount },
    createdAt: u.createdAt.toISOString(),
  };
}

const withProfile = { playerProfile: { select: { id: true } } } as const;

export async function getMe(userId: string) {
  return toMe(await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: withProfile }));
}

export async function updateMe(
  userId: string,
  patch: { name?: string; birthYear?: number | null; locale?: "bn" | "en"; phone?: string | null },
) {
  if (patch.phone !== undefined) {
    const loginPhone = await prisma.authAccount.findFirst({ where: { userId, provider: "PHONE" }, select: { id: true } });
    if (loginPhone) throw AppError.conflict("USER_PHONE_LOCKED", "Your number is used to sign in; change it by verifying a new one");
  }
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...patch,
        // A changed number is unverified until a verification flow exists; clearing it clears the flag too.
        ...(patch.phone !== undefined && { phoneVerifiedAt: null }),
      },
      include: withProfile,
    });
    return toMe(user);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("USER_PHONE_TAKEN", "That phone number is already in use");
    }
    throw err;
  }
}

export async function setAvatar(userId: string, buffer: Buffer) {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarPublicId: true } });
  const image = await uploadOwnedImage(userId, "avatar", buffer);
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: image.url, avatarPublicId: image.publicId },
      include: withProfile,
    });
    await deleteImagesQuietly([before.avatarPublicId]);
    return toMe(user);
  } catch (err) {
    await deleteImagesQuietly([image.publicId]); // don't leave an orphan if the DB write failed
    throw err;
  }
}

export async function removeAvatar(userId: string) {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarPublicId: true } });
  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: null, avatarPublicId: null },
    include: withProfile,
  });
  await deleteImagesQuietly([before.avatarPublicId]);
  return toMe(user);
}
