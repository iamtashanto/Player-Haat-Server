import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

export interface LocationIds {
  districtId: number;
  upazilaId: number;
  unionId?: number | null;
}

/**
 * Checks that district ⊃ upazila ⊃ union actually nest, so a profile/request/team can never claim
 * "Kalapara upazila in Dhaka district". Shared by players now and requests/teams later.
 */
export async function assertValidLocation(loc: LocationIds): Promise<void> {
  const upazila = await prisma.upazila.findUnique({
    where: { id: loc.upazilaId },
    select: { districtId: true },
  });
  if (!upazila) throw new AppError("LOCATION_INVALID", 422, "Unknown upazila", { field: "upazilaId" });
  if (upazila.districtId !== loc.districtId) {
    throw new AppError("LOCATION_INVALID", 422, "Upazila does not belong to that district", { field: "upazilaId" });
  }
  if (loc.unionId != null) {
    const union = await prisma.union.findUnique({ where: { id: loc.unionId }, select: { upazilaId: true } });
    if (!union) throw new AppError("LOCATION_INVALID", 422, "Unknown union", { field: "unionId" });
    if (union.upazilaId !== loc.upazilaId) {
      throw new AppError("LOCATION_INVALID", 422, "Union does not belong to that upazila", { field: "unionId" });
    }
  }
}

export const locationInclude = {
  district: { select: { id: true, nameBn: true, nameEn: true } },
  upazila: { select: { id: true, nameBn: true, nameEn: true } },
  union: { select: { id: true, nameBn: true, nameEn: true } },
} as const;
