import { AppError, ErrorCode } from "../../lib/errors.js";
import { verifyPassword } from "../../lib/password.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { prisma } from "../../lib/prisma.js";
import { retireParticipation } from "../moderation/participation.js";
import { notify, type NotifyInput } from "../notifications/notifier.js";
import { revokeAllForUser } from "./token.service.js";

/**
 * Account deletion (Google Play / App Store requirement): soft-delete + anonymize.
 * The User row stays so ratings and request history keep referential integrity, but nothing
 * personal remains: name, email, phone, avatar, birth year, credentials, media and tokens are gone.
 */
export async function deleteAccount(userId: string, input: { password?: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Accounts with a password must re-enter it; social-only accounts are already authenticated by a live token.
  if (user.passwordHash) {
    if (!input.password) throw AppError.badRequest(ErrorCode.AUTH_PASSWORD_REQUIRED, "Password required");
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      throw AppError.badRequest(ErrorCode.AUTH_WRONG_PASSWORD, "Password is incorrect");
    }
  }

  const now = new Date();
  let effects: NotifyInput[] = [];
  const orphanedMedia = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        status: "DELETED",
        deletedAt: now,
        name: "Deleted user",
        email: null,
        emailVerifiedAt: null,
        phone: null,
        phoneVerifiedAt: null,
        passwordHash: null,
        avatarUrl: null,
        avatarPublicId: null,
        birthYear: null,
      },
    });

    await revokeAllForUser(userId, tx);
    await tx.authAccount.deleteMany({ where: { userId } });
    await tx.verificationCode.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });

    // Stop the account from taking part in anything still in motion (and tell the other side).
    effects = await retireParticipation(tx, userId);

    const avatar = user.avatarPublicId ? [user.avatarPublicId] : [];
    const profile = await tx.playerProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) return avatar;
    await tx.playerProfile.update({ where: { id: profile.id }, data: { isVisible: false, bio: null } });
    const media = await tx.playerMedia.findMany({ where: { profileId: profile.id, publicId: { not: null } } });
    await tx.playerMedia.deleteMany({ where: { profileId: profile.id } });
    return [...avatar, ...media.map((m) => m.publicId!)];
  });

  // The DB is already anonymized; purge the stored images (best-effort, failures are logged).
  await deleteImagesQuietly(orphanedMedia);
  for (const e of effects) notify(e);
}
