import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { assertValidLocation } from "../locations/location.service.js";
import { notify } from "../notifications/notifier.js";
import { getPricing, getPublicConfig } from "../app-config/app-config.service.js";
import { spendCredits } from "../billing/credits.service.js";
import { announceNewRequest } from "./matching.service.js";
import { lockRequest } from "./request-lock.js";
import { toRequest, requestInclude, type RequestRow, type ViewerContext } from "./requests.presenter.js";
import { MAX_DAYS_AHEAD, MAX_OPEN_REQUESTS, type createRequestBody, type featuredQuery, type feedQuery, type mineQuery, type updateRequestBody } from "./requests.schema.js";

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;

const display = (r: RequestRow) => ({
  sport: { bn: r.sport.nameBn, en: r.sport.nameEn },
  venue: r.venueText,
  when: r.matchAt,
});

// ───────────────────────── helpers ─────────────────────────

/** The viewer's own application per request, so the app can render "Applied ✓" without N calls. */
async function viewerContext(viewerId: string, rows: RequestRow[], withPending = false): Promise<ViewerContext> {
  const ids = rows.map((r) => r.id);
  const eventIds = rows.filter((r) => r.kind === "EVENT").map((r) => r.id);
  const [mine, pending, interestCounts, previewRows] = await Promise.all([
    prisma.application.findMany({
      where: { playerId: viewerId, requestId: { in: ids } },
      select: { id: true, requestId: true, status: true },
    }),
    withPending
      ? prisma.application.groupBy({
          by: ["requestId"],
          where: { requestId: { in: ids }, status: "PENDING" },
          _count: { _all: true },
        })
      : [],
    prisma.application.groupBy({ by: ["requestId"], where: { requestId: { in: ids }, status: { in: ["PENDING", "ACCEPTED"] } }, _count: { _all: true } }),
    // A few faces for events, so a player sees who else is going. Only players who are publicly visible.
    eventIds.length === 0
      ? []
      : prisma.application.findMany({
          where: { requestId: { in: eventIds }, status: { in: ["PENDING", "ACCEPTED"] }, player: { status: "ACTIVE", playerProfile: { is: { isVisible: true, hiddenByAdminAt: null } } } },
          orderBy: { createdAt: "desc" },
          take: eventIds.length * 6,
          select: { requestId: true, player: { select: { name: true, avatarUrl: true, playerProfile: { select: { id: true } } } } },
        }),
  ]);
  const previews = new Map<string, { profileId: string; name: string; avatarUrl: string | null }[]>();
  for (const a of previewRows) {
    const list = previews.get(a.requestId) ?? [];
    if (list.length < 5 && a.player.playerProfile) list.push({ profileId: a.player.playerProfile.id, name: a.player.name, avatarUrl: a.player.avatarUrl });
    previews.set(a.requestId, list);
  }
  return {
    interest: new Map(interestCounts.map((c) => [c.requestId, { count: c._count._all, preview: previews.get(c.requestId) ?? [] }])),
    viewerId,
    myApplications: new Map(mine.map((a) => [a.requestId, { id: a.id, status: a.status }])),
    pendingCounts: withPending ? new Map(pending.map((p) => [p.requestId, p._count._all])) : undefined,
  };
}

async function presentOne(viewerId: string, r: RequestRow) {
  return toRequest(r, await viewerContext(viewerId, [r], r.createdById === viewerId));
}

function assertOwner(r: { createdById: string }, userId: string) {
  if (r.createdById !== userId) throw AppError.forbidden("REQUEST_NOT_OWNER", "Only the person who posted this request can do that");
}

function assertStillActive(r: { status: string }) {
  if (r.status !== "OPEN" && r.status !== "FILLED") {
    throw AppError.conflict("REQUEST_CLOSED", `This request is ${r.status.toLowerCase()}`);
  }
}

/** Cross-field rules shared by create and update. */
function validateState(s: { matchAt: Date; isPaid: boolean; budgetMin: number | null; budgetMax: number | null }, opts: { checkTime: boolean }) {
  if (opts.checkTime) {
    const now = Date.now();
    if (s.matchAt.getTime() <= now) throw AppError.invalid("matchAt", "Match time must be in the future");
    if (s.matchAt.getTime() > now + MAX_DAYS_AHEAD * DAY_MS) throw AppError.invalid("matchAt", `At most ${MAX_DAYS_AHEAD} days ahead`);
  }
  if (!s.isPaid && (s.budgetMin !== null || s.budgetMax !== null)) {
    throw AppError.invalid("isPaid", "A budget can only be set on a paid request");
  }
  if (s.budgetMin !== null && s.budgetMax !== null && s.budgetMin > s.budgetMax) {
    throw AppError.invalid("budgetMin", "budgetMin must be ≤ budgetMax");
  }
}

async function assertPositionsFor(sportId: number, positions: string[]) {
  if (positions.length === 0) return;
  const valid = new Set((await prisma.position.findMany({ where: { sportId }, select: { code: true } })).map((p) => p.code));
  const unknown = positions.filter((p) => !valid.has(p));
  if (unknown.length) throw AppError.invalid("positionsNeeded", `Unknown position(s): ${unknown.join(", ")}. Valid: ${[...valid].join(", ")}`);
}

// ───────────────────────── create ─────────────────────────

export async function createRequest(userId: string, input: z.infer<typeof createRequestBody>) {
  const sport = await prisma.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } });
  if (!sport) throw AppError.invalid("sportId", "Unknown or inactive sport");

  const kind = input.kind ?? "MATCH";
  if (kind === "EVENT") {
    const poster = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
    if (poster.role !== "RECRUITER") throw AppError.forbidden("EVENT_RECRUITERS_ONLY", "Only recruiters can launch events");
  }

  const matchAt = new Date(input.matchAt);
  const isPaid = input.isPaid ?? false;
  const budgetMin = input.budgetMin ?? null;
  const budgetMax = input.budgetMax ?? null;
  const positionsNeeded = [...new Set(input.positionsNeeded ?? [])];
  validateState({ matchAt, isPaid, budgetMin, budgetMax }, { checkTime: true });
  await assertPositionsFor(input.sportId, positionsNeeded);
  await assertValidLocation(input);

  if (input.teamId) {
    const team = await prisma.team.findUnique({ where: { id: input.teamId }, select: { captainId: true, sportId: true } });
    if (!team || team.captainId !== userId) throw AppError.invalid("teamId", "You can only post for a team you captain");
    if (team.sportId !== input.sportId) throw AppError.invalid("teamId", "Team plays a different sport");
  }

  const open = await prisma.playerRequest.count({
    where: { createdById: userId, status: { in: ["OPEN", "FILLED"] }, matchAt: { gt: new Date() } },
  });
  if (open >= MAX_OPEN_REQUESTS) {
    throw AppError.conflict("REQUEST_LIMIT", `You can have at most ${MAX_OPEN_REQUESTS} active upcoming requests`);
  }

  const created = await prisma.playerRequest.create({
    data: {
      createdById: userId,
      teamId: input.teamId ?? null,
      sportId: input.sportId,
      matchAt,
      venueText: input.venueText,
      districtId: input.districtId,
      upazilaId: input.upazilaId,
      unionId: input.unionId ?? null,
      positionsNeeded,
      playersNeeded: input.playersNeeded ?? 1,
      isPaid,
      budgetMin,
      budgetMax,
      notes: input.notes ?? null,
      kind,
      title: kind === "EVENT" ? (input.title ?? null) : null,
    },
    include: requestInclude,
  });

  announceNewRequest(created.id);
  return presentOne(userId, created);
}

// ───────────────────────── read ─────────────────────────

export async function getRequest(viewerId: string, id: string) {
  const r = await prisma.playerRequest.findUnique({ where: { id }, include: requestInclude });
  // Hidden / suspended-poster requests don't exist for anyone but the poster.
  const hiddenFromViewer = r && r.createdById !== viewerId && (r.isHidden || (await isSuspended(r.createdById)));
  if (!r || hiddenFromViewer) throw AppError.notFound("REQUEST_NOT_FOUND", "Request not found");
  return presentOne(viewerId, r);
}

const isSuspended = async (userId: string) =>
  (await prisma.user.findUnique({ where: { id: userId }, select: { status: true } }))?.status !== "ACTIVE";

/** Open, upcoming requests from other people, soonest first. */
export async function feed(viewerId: string, q: z.infer<typeof feedQuery>) {
  const where: Prisma.PlayerRequestWhereInput = {
    status: "OPEN",
    isHidden: false,
    matchAt: { gt: new Date() },
    createdById: { not: viewerId },
    createdBy: { status: "ACTIVE" },
    ...(q.sportId !== undefined && { sportId: q.sportId }),
    ...(q.districtId !== undefined && { districtId: q.districtId }),
    ...(q.upazilaId !== undefined && { upazilaId: q.upazilaId }),
    ...(q.unionId !== undefined && { unionId: q.unionId }),
    ...(q.isPaid !== undefined && { isPaid: q.isPaid }),
    ...(q.kind && { kind: q.kind }),
    // A request listing no positions is open to everyone, so it matches any position filter.
    ...(q.position && { OR: [{ positionsNeeded: { has: q.position } }, { positionsNeeded: { isEmpty: true } }] }),
  };
  const rows = await prisma.playerRequest.findMany({
    where,
    include: requestInclude,
    orderBy: [{ matchAt: "asc" }, { id: "asc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  const ctx = await viewerContext(viewerId, items);
  return { items: items.map((r) => toRequest(r, ctx)), nextCursor };
}

export async function myRequests(userId: string, q: z.infer<typeof mineQuery>) {
  const rows = await prisma.playerRequest.findMany({
    where: { createdById: userId, ...(q.status && { status: q.status }) },
    include: requestInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  const ctx = await viewerContext(userId, items, true);
  return { items: items.map((r) => toRequest(r, ctx)), nextCursor };
}

// ───────────────────────── update ─────────────────────────

export async function updateRequest(userId: string, id: string, patch: z.infer<typeof updateRequestBody>) {
  const { updated, notifyAccepted } = await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    assertOwner(r, userId);
    assertStillActive(r);

    const isPaid = patch.isPaid ?? r.isPaid;
    const state = {
      matchAt: patch.matchAt ? new Date(patch.matchAt) : r.matchAt,
      isPaid,
      // Switching to a free match drops the budget unless the caller says otherwise (validation then rejects it).
      budgetMin: patch.budgetMin !== undefined ? patch.budgetMin : isPaid ? r.budgetMin : null,
      budgetMax: patch.budgetMax !== undefined ? patch.budgetMax : isPaid ? r.budgetMax : null,
    };
    validateState(state, { checkTime: patch.matchAt !== undefined });

    const positionsNeeded = patch.positionsNeeded ? [...new Set(patch.positionsNeeded)] : r.positionsNeeded;
    if (patch.positionsNeeded) await assertPositionsFor(r.sportId, positionsNeeded);

    const playersNeeded = patch.playersNeeded ?? r.playersNeeded;
    if (playersNeeded < r.playersAccepted) {
      throw AppError.invalid("playersNeeded", `Can't be fewer than the ${r.playersAccepted} players already accepted`);
    }
    // Raising the number re-opens a filled request; lowering it to the accepted count fills it.
    const status = playersNeeded <= r.playersAccepted ? "FILLED" : "OPEN";

    const notifyAccepted =
      (patch.matchAt !== undefined && state.matchAt.getTime() !== r.matchAt.getTime()) ||
      (patch.venueText !== undefined && patch.venueText !== r.venueText);

    const updated = await tx.playerRequest.update({
      where: { id },
      data: {
        matchAt: state.matchAt,
        ...(patch.venueText !== undefined && { venueText: patch.venueText }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.title !== undefined && r.kind === "EVENT" && { title: patch.title }),
        positionsNeeded,
        playersNeeded,
        isPaid,
        budgetMin: state.budgetMin,
        budgetMax: state.budgetMax,
        status,
      },
      include: requestInclude,
    });
    return { updated, notifyAccepted };
  });

  if (notifyAccepted) {
    const accepted = await prisma.application.findMany({ where: { requestId: id, status: "ACCEPTED" }, select: { playerId: true } });
    notify({ userIds: accepted.map((a) => a.playerId), type: "REQUEST_UPDATED", data: { requestId: id }, params: display(updated) });
  }
  return presentOne(userId, updated);
}

// ───────────────────────── status transitions ─────────────────────────

/** Ends the application phase: anything still pending can no longer be accepted. */
const closePending = (tx: Tx, requestId: string) =>
  tx.application.updateMany({ where: { requestId, status: "PENDING" }, data: { status: "REJECTED", respondedAt: new Date() } });

export async function cancelRequest(userId: string, id: string) {
  const { updated, audience } = await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    assertOwner(r, userId);
    assertStillActive(r);

    const audience = await tx.application.findMany({
      where: { requestId: id, status: { in: ["ACCEPTED", "PENDING"] } },
      select: { playerId: true },
    });
    await closePending(tx, id);
    const updated = await tx.playerRequest.update({ where: { id }, data: { status: "CANCELLED" }, include: requestInclude });
    return { updated, audience };
  });
  notify({ userIds: audience.map((a) => a.playerId), type: "REQUEST_CANCELLED", data: { requestId: id }, params: display(updated) });
  return presentOne(userId, updated);
}

export async function fillRequest(userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    assertOwner(r, userId);
    if (r.status !== "OPEN") throw AppError.conflict("REQUEST_NOT_OPEN", `This request is ${r.status.toLowerCase()}`);
    const updated = await tx.playerRequest.update({ where: { id }, data: { status: "FILLED" }, include: requestInclude });
    return toRequest(updated, { viewerId: userId, pendingCounts: new Map() });
  });
}

export async function completeRequest(userId: string, id: string) {
  const updated = await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    assertOwner(r, userId);
    assertStillActive(r);
    if (r.matchAt.getTime() > Date.now()) throw AppError.conflict("REQUEST_NOT_STARTED", "The match hasn't started yet");
    if (r.playersAccepted < 1) {
      throw AppError.conflict("REQUEST_NO_ACCEPTED_PLAYERS", "No players were accepted — cancel the request instead");
    }
    await closePending(tx, id);
    return tx.playerRequest.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() }, include: requestInclude });
  });

  // Open the rating window with a nudge to everyone who played (the poster is already on the screen).
  const players = await prisma.application.findMany({ where: { requestId: id, status: "ACCEPTED" }, select: { playerId: true } });
  notify({ userIds: players.map((p) => p.playerId), type: "RATING_REMINDER", data: { requestId: id, kind: "now" }, params: display(updated) });
  return presentOne(userId, updated);
}

// ───────────────────────── boost ─────────────────────────

/** Running boosts the viewer may see, using the same visibility rules as the feed. */
export async function featured(viewerId: string, q: z.infer<typeof featuredQuery>) {
  const rows = await prisma.playerRequest.findMany({
    where: {
      status: "OPEN",
      isHidden: false,
      matchAt: { gt: new Date() },
      boostedUntil: { gt: new Date() },
      createdById: { not: viewerId },
      createdBy: { status: "ACTIVE" },
      ...(q.kind && { kind: q.kind }),
      ...(q.sportId !== undefined && { sportId: q.sportId }),
      ...(q.districtId !== undefined && { districtId: q.districtId }),
      ...(q.upazilaId !== undefined && { upazilaId: q.upazilaId }),
    },
    include: requestInclude,
    orderBy: [{ boostedUntil: "desc" }, { id: "asc" }],
    take: q.limit,
  });
  const ctx = await viewerContext(viewerId, rows);
  return rows.map((r) => toRequest(r, ctx));
}

export async function boostRequest(userId: string, id: string) {
  const pricing = (await getPublicConfig()).flags.boost_enabled ? await getPricing() : null;
  if (!pricing) throw AppError.conflict("BOOST_UNAVAILABLE", "Boosting isn't available right now");

  const updated = await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id);
    assertOwner(r, userId);
    assertStillActive(r);
    if (r.isHidden) throw AppError.conflict("REQUEST_CLOSED", "A hidden request can't be boosted");
    if (r.matchAt.getTime() <= Date.now()) throw AppError.conflict("REQUEST_EXPIRED", "This match has already started");

    await spendCredits(tx, userId, pricing.boostCreditCost, "BOOST", { refType: "PlayerRequest", refId: id });
    const base = Math.max(Date.now(), r.boostedUntil?.getTime() ?? 0); // boosting again extends, never overlaps
    return tx.playerRequest.update({ where: { id }, data: { boostedUntil: new Date(base + pricing.boostHours * 3_600_000) }, include: requestInclude });
  });
  return presentOne(userId, updated);
}
