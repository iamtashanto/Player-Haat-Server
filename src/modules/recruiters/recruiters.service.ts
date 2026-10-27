import { Prisma } from "@prisma/client";
import type { RequestHandler } from "express";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { authUser } from "../../middlewares/auth.js";
import type { createRecruiterBody, updateRecruiterBody } from "./recruiters.schema.js";

const NOT_FOUND = "RECRUITER_PROFILE_NOT_FOUND";

const include = {
  user: { select: { name: true, avatarUrl: true } },
  district: { select: { id: true, nameBn: true, nameEn: true } },
} satisfies Prisma.RecruiterProfileInclude;
type Full = Prisma.RecruiterProfileGetPayload<{ include: typeof include }>;

/** Public card: no email, phone or user id. */
const toCard = (r: Full) => ({
  id: r.id,
  name: r.user.name,
  avatarUrl: r.user.avatarUrl,
  type: r.type,
  organization: r.organization,
  bio: r.bio,
  district: r.district,
  sportIds: r.sportIds,
  verifiedBadge: r.verifiedBadge,
});

async function assertValidSports(sportIds: number[]) {
  const found = await prisma.sport.count({ where: { id: { in: sportIds }, isActive: true } });
  if (found !== sportIds.length) throw AppError.invalid("sportIds", "Unknown or inactive sport");
}

async function assertDistrict(districtId: number) {
  if (!(await prisma.district.findUnique({ where: { id: districtId }, select: { id: true } }))) {
    throw new AppError("LOCATION_INVALID", 422, "Unknown district", { field: "districtId" });
  }
}

export async function getMyRecruiterProfile(userId: string) {
  const r = await prisma.recruiterProfile.findUnique({ where: { userId }, include });
  if (!r) throw AppError.notFound(NOT_FOUND, "Set up your recruiter profile first");
  return toCard(r);
}

export async function createRecruiterProfile(userId: string, input: z.infer<typeof createRecruiterBody>) {
  await assertDistrict(input.districtId);
  await assertValidSports(input.sportIds);
  try {
    const r = await prisma.recruiterProfile.create({
      data: { userId, type: input.type, organization: input.organization ?? null, bio: input.bio ?? null, districtId: input.districtId, sportIds: input.sportIds },
      include,
    });
    return toCard(r);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("RECRUITER_PROFILE_EXISTS", "You already have a recruiter profile");
    }
    throw err;
  }
}

export async function updateRecruiterProfile(userId: string, patch: z.infer<typeof updateRecruiterBody>) {
  if (patch.districtId !== undefined) await assertDistrict(patch.districtId);
  if (patch.sportIds) await assertValidSports(patch.sportIds);
  try {
    // Changing who they say they are drops a granted verification: an admin checked the old details.
    const identityChanged = patch.type !== undefined || patch.organization !== undefined;
    const r = await prisma.recruiterProfile.update({
      where: { userId },
      data: { ...patch, ...(identityChanged && { verifiedBadge: false }) },
      include,
    });
    return toCard(r);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw AppError.notFound(NOT_FOUND, "Set up your recruiter profile first");
    throw err;
  }
}

export async function getPublicRecruiter(id: string) {
  const r = await prisma.recruiterProfile.findFirst({ where: { id, user: { status: "ACTIVE", role: "RECRUITER" } }, include });
  if (!r) throw AppError.notFound(NOT_FOUND, "Recruiter not found");
  return toCard(r);
}

/**
 * Recruiters finish onboarding before they can browse players: players can see who is looking at them,
 * and it keeps throwaway accounts from scraping the directory. A no-op for everyone else.
 */
export const requireOnboardedRecruiter: RequestHandler = async (req, _res, next) => {
  const { userId, role } = authUser(req);
  if (role !== "RECRUITER") return next();
  const profile = await prisma.recruiterProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw AppError.forbidden("RECRUITER_PROFILE_REQUIRED", "Complete your recruiter profile to discover players");
  next();
};
