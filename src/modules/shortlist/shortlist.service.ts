import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { profileInclude, toPlayerCard } from "../players/players.presenter.js";
import { MAX_SHORTLIST, type saveBody, type shortlistQuery } from "./shortlist.schema.js";

/** Which of these profiles has the viewer saved? One indexed query for a whole page of results. */
export async function shortlistedAmong(viewerId: string, profileIds: string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = await prisma.shortlistEntry.findMany({ where: { recruiterId: viewerId, profileId: { in: profileIds } }, select: { profileId: true } });
  return new Set(rows.map((r) => r.profileId));
}

export async function save(recruiterId: string, profileId: string, input: z.infer<typeof saveBody>) {
  const visible = await prisma.playerProfile.findFirst({ where: { id: profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" } }, select: { id: true } });
  if (!visible) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player not found");

  const existing = await prisma.shortlistEntry.findUnique({ where: { recruiterId_profileId: { recruiterId, profileId } }, select: { id: true } });
  if (!existing && (await prisma.shortlistEntry.count({ where: { recruiterId } })) >= MAX_SHORTLIST) {
    throw AppError.conflict("SHORTLIST_FULL", `You can save up to ${MAX_SHORTLIST} players`);
  }
  const note = input.note ?? null;
  const row = await prisma.shortlistEntry.upsert({
    where: { recruiterId_profileId: { recruiterId, profileId } },
    // Saving again without a note keeps the old note; sending a note (or null explicitly) replaces it.
    update: input.note !== undefined ? { note } : {},
    create: { recruiterId, profileId, note },
  });
  return { profileId, note: row.note, savedAt: row.createdAt.toISOString() };
}

export async function remove(recruiterId: string, profileId: string) {
  const { count } = await prisma.shortlistEntry.deleteMany({ where: { recruiterId, profileId } });
  return { removed: count > 0 };
}

export async function list(recruiterId: string, q: z.infer<typeof shortlistQuery>) {
  const rows = await prisma.shortlistEntry.findMany({
    where: {
      recruiterId,
      profile: { isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" }, ...(q.sportId && { sports: { some: { sportId: q.sportId, isVisible: true, hiddenByAdminAt: null } } }) },
    },
    include: { profile: { include: profileInclude } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({ savedAt: r.createdAt.toISOString(), note: r.note, player: toPlayerCard(r.profile, q.sportId ? [q.sportId] : [], true) })),
    nextCursor,
  };
}
