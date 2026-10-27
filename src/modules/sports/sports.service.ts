import { prisma } from "../../lib/prisma.js";
import { statFieldsFor } from "../players/sport-stats.js";

export const listSports = async () =>
  (await prisma.sport.findMany({
    where: { isActive: true },
    orderBy: { id: "asc" },
    select: {
      id: true,
      code: true,
      nameBn: true,
      nameEn: true,
      positions: { orderBy: { order: "asc" }, select: { code: true, nameBn: true, nameEn: true } },
    },
  })).map((sp) => ({ ...sp, statFields: statFieldsFor(sp.code) }));
