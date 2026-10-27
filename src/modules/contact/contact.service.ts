import type { ContactVisibility, Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { getPricing } from "../app-config/app-config.service.js";
import { spendCredits } from "../billing/credits.service.js";
import { notify } from "../notifications/notifier.js";
import type { contactViewsQuery } from "./contact.schema.js";
import { haveAcceptedRelation } from "./relation.js";

const DAY_MS = 86_400_000;

/** The player behind a profile id, as a viewer is allowed to reach them (hidden/suspended ones don't exist). */
async function loadTarget(profileId: string) {
  const p = await prisma.playerProfile.findFirst({
    where: { id: profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" } },
    select: { id: true, userId: true, contactVisibility: true, user: { select: { phone: true, name: true } } },
  });
  if (!p) throw AppError.notFound("PLAYER_PROFILE_NOT_FOUND", "Player not found");
  return p;
}

type Access = { state: "OPEN" | "RELATED" | "LOCKED"; visibility: ContactVisibility };

async function accessFor(viewerId: string, target: { userId: string; contactVisibility: ContactVisibility }): Promise<Access> {
  if (await haveAcceptedRelation(viewerId, target.userId)) return { state: "RELATED", visibility: target.contactVisibility };
  return { state: target.contactVisibility === "ON_TAP" ? "OPEN" : "LOCKED", visibility: target.contactVisibility };
}

/** How many numbers this viewer opened in the last 24h that cost them (or used up) the free allowance. */
const revealsToday = (viewerId: string) => prisma.contactReveal.count({ where: { viewerId, createdAt: { gte: new Date(Date.now() - DAY_MS) } } });

/** What a tap would do right now, so the app can show a price *before* asking for one. */
async function quote(viewerId: string, access: Access) {
  const pricing = await getPricing();
  if (access.state === "RELATED" || !pricing.contactCreditsEnabled || pricing.contactCreditCost === 0) {
    return { cost: 0, freeLeftToday: null as number | null };
  }
  const used = await revealsToday(viewerId);
  const freeLeft = Math.max(0, pricing.freeContactsPerDay - used);
  return { cost: freeLeft > 0 ? 0 : pricing.contactCreditCost, freeLeftToday: freeLeft };
}

/** Preflight: can I see this number, would it cost anything, have I already opened it? */
export async function contactStatus(viewerId: string, profileId: string) {
  const target = await loadTarget(profileId);
  if (target.userId === viewerId) return { state: "SELF" as const, visibility: target.contactVisibility, hasPhone: target.user.phone !== null, alreadyRevealed: true, cost: 0, freeLeftToday: null, balance: null };
  const access = await accessFor(viewerId, target);
  const [revealed, q, me] = await Promise.all([
    prisma.contactReveal.findUnique({ where: { viewerId_profileId: { viewerId, profileId } }, select: { id: true } }),
    quote(viewerId, access),
    prisma.user.findUniqueOrThrow({ where: { id: viewerId }, select: { creditBalance: true } }),
  ]);
  const alreadyRevealed = revealed !== null && access.state !== "LOCKED";
  return {
    state: access.state,
    visibility: access.visibility,
    hasPhone: target.user.phone !== null,
    alreadyRevealed,
    cost: alreadyRevealed ? 0 : q.cost,
    freeLeftToday: q.freeLeftToday,
    balance: me.creditBalance,
  };
}

/** The tap. Idempotent per (viewer, player): opening the same number again is free and silent. */
export async function revealContact(viewerId: string, profileId: string) {
  const target = await loadTarget(profileId);
  if (target.userId === viewerId) return { phone: target.user.phone, cost: 0, balance: null };

  const access = await accessFor(viewerId, target);
  if (access.state === "LOCKED") {
    throw new AppError("CONTACT_LOCKED", 403, "This player shares their number only with people they've accepted", { visibility: access.visibility });
  }
  if (!target.user.phone) throw AppError.conflict("PLAYER_NO_PHONE", "This player hasn't added a phone number");

  const existing = await prisma.contactReveal.findUnique({ where: { viewerId_profileId: { viewerId, profileId } }, select: { id: true } });
  if (existing) return { phone: target.user.phone, cost: 0, balance: (await prisma.user.findUniqueOrThrow({ where: { id: viewerId }, select: { creditBalance: true } })).creditBalance };

  const { cost } = await quote(viewerId, access);
  const balance = await prisma.$transaction(async (tx) => {
    // The unique (viewer, profile) row is the guard: two simultaneous first taps can't both charge.
    await tx.contactReveal.create({ data: { viewerId, profileId, cost } });
    if (cost > 0) return spendCredits(tx, viewerId, cost, "CONTACT_REVEAL", { refType: "PlayerProfile", refId: profileId });
    return (await tx.user.findUniqueOrThrow({ where: { id: viewerId }, select: { creditBalance: true } })).creditBalance;
  }).catch(async (err: unknown) => {
    if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") return null; // lost a race to ourselves: already revealed
    throw err;
  });

  if (balance !== null) {
    const viewer = await prisma.user.findUniqueOrThrow({ where: { id: viewerId }, select: { name: true, recruiterProfile: { select: { id: true, organization: true } } } });
    notify({
      userIds: [target.userId],
      type: "CONTACT_VIEWED",
      data: { profileId, ...(viewer.recruiterProfile && { recruiterId: viewer.recruiterProfile.id }) },
      params: { actor: viewer.recruiterProfile?.organization ? `${viewer.name} · ${viewer.recruiterProfile.organization}` : viewer.name },
    });
  }
  return { phone: target.user.phone, cost: balance === null ? 0 : cost, balance };
}

/** "Who looked at my number": newest first, with enough about each person to decide whether to reply. */
export async function myContactViews(userId: string, q: z.infer<typeof contactViewsQuery>) {
  const rows = await prisma.contactReveal.findMany({
    where: { profile: { userId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { viewer: { select: { name: true, avatarUrl: true, role: true, recruiterProfile: { select: { id: true, type: true, organization: true, verifiedBadge: true } } } } },
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return {
    items: items.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      viewer: {
        name: r.viewer.name,
        avatarUrl: r.viewer.avatarUrl,
        role: r.viewer.role,
        recruiterId: r.viewer.recruiterProfile?.id ?? null,
        recruiterType: r.viewer.recruiterProfile?.type ?? null,
        organization: r.viewer.recruiterProfile?.organization ?? null,
        verified: r.viewer.recruiterProfile?.verifiedBadge ?? false,
      },
    })),
    nextCursor,
  };
}
