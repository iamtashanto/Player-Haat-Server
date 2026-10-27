import type { PrismaClient } from "@prisma/client";
import { sports } from "./data/sports.js";

export async function seedSports(prisma: PrismaClient) {
  for (const s of sports) {
    const sport = await prisma.sport.upsert({
      where: { code: s.code },
      update: { nameEn: s.nameEn, nameBn: s.nameBn },
      create: { code: s.code, nameEn: s.nameEn, nameBn: s.nameBn },
    });
    for (const [order, p] of s.positions.entries()) {
      await prisma.position.upsert({
        where: { sportId_code: { sportId: sport.id, code: p.code } },
        update: { nameEn: p.nameEn, nameBn: p.nameBn, order },
        create: { sportId: sport.id, code: p.code, nameEn: p.nameEn, nameBn: p.nameBn, order },
      });
    }
  }
  return { sports: sports.length, positions: sports.reduce((n, s) => n + s.positions.length, 0) };
}
