import { prisma } from "../../lib/prisma.js";

export const listSports = () =>
  prisma.sport.findMany({
    where: { isActive: true },
    orderBy: { id: "asc" },
    select: {
      id: true,
      code: true,
      nameBn: true,
      nameEn: true,
      positions: { orderBy: { order: "asc" }, select: { code: true, nameBn: true, nameEn: true } },
    },
  });
