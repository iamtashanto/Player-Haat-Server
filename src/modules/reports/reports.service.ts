import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { createReportBody } from "./reports.schema.js";

type Body = z.infer<typeof createReportBody>;

/** Throws unless the target exists, is something the reporter could have seen, and isn't theirs. */
async function assertReportable(userId: string, t: Pick<Body, "targetType" | "targetId">) {
  const missing = () => AppError.notFound("REPORT_TARGET_NOT_FOUND", "Nothing to report with that id");
  const own = () => AppError.invalid("targetId", "You can't report your own content");

  switch (t.targetType) {
    case "PLAYER_PROFILE": {
      const p = await prisma.playerProfile.findUnique({ where: { id: t.targetId }, select: { userId: true } });
      if (!p) throw missing();
      if (p.userId === userId) throw own();
      return;
    }
    case "REQUEST": {
      const r = await prisma.playerRequest.findUnique({ where: { id: t.targetId }, select: { createdById: true, isHidden: true } });
      if (!r || r.isHidden) throw missing();
      if (r.createdById === userId) throw own();
      return;
    }
    case "TEAM": {
      const team = await prisma.team.findUnique({ where: { id: t.targetId }, select: { captainId: true } });
      if (!team) throw missing();
      if (team.captainId === userId) throw own();
      return;
    }
    case "RATING": {
      const r = await prisma.rating.findUnique({ where: { id: t.targetId }, select: { raterId: true } });
      if (!r) throw missing();
      if (r.raterId === userId) throw own();
      return;
    }
  }
}

export async function createReport(userId: string, body: Body) {
  await assertReportable(userId, body);

  const dup = await prisma.report.findFirst({
    where: { reporterId: userId, targetType: body.targetType, targetId: body.targetId, status: "OPEN" },
    select: { id: true },
  });
  if (dup) throw AppError.conflict("REPORT_EXISTS", "You already reported this; we're looking into it");

  const report = await prisma.report.create({
    data: { reporterId: userId, targetType: body.targetType, targetId: body.targetId, reason: body.reason, details: body.details ?? null },
  });
  return { id: report.id, status: "OPEN" as const, createdAt: report.createdAt.toISOString() };
}
