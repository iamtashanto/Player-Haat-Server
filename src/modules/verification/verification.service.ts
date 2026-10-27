import type { Prisma, VerificationRequest } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage/index.js";
import { isOwnedBy } from "../../lib/storage/paths.js";
import { notify } from "../notifications/notifier.js";
import type { adminQuery, reviewBody, submitRecruiterBody } from "./verification.schema.js";

type Evidence = z.infer<typeof submitRecruiterBody>;
type Images = { url: string; publicId: string }[];

const images = (v: VerificationRequest): Images => (Array.isArray(v.evidenceImages) ? (v.evidenceImages as Images) : []);

function toStatus(v: VerificationRequest) {
  return {
    id: v.id,
    kind: v.kind,
    status: v.status,
    note: v.note,
    evidenceLinks: v.evidenceLinks,
    evidenceImages: images(v).map((i) => ({ url: i.url })), // the owner never needs the storage ids
    reviewNote: v.status === "REJECTED" ? v.reviewNote : null,
    createdAt: v.createdAt.toISOString(),
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
  };
}

/**
 * Evidence images are named by the client but never trusted: each id must sit in the submitter's own upload
 * folder (so nobody can attach someone else's file), and the URL is rebuilt here from the id.
 */
function resolveImages(userId: string, input: Evidence): Images {
  const unique = [...new Set(input.evidenceImages.map((i) => i.publicId))];
  for (const id of unique) {
    if (!isOwnedBy(userId, id) || !id.includes("/verification-docs/")) throw AppError.invalid("evidenceImages", "Upload each document with type verification-doc first");
  }
  return unique.map((publicId) => ({ publicId, url: storage.urlFor(publicId) }));
}

const isUnique = (e: unknown) => (e as Prisma.PrismaClientKnownRequestError).code === "P2002";

// ───────────────────────── recruiters ─────────────────────────

export async function submitRecruiter(userId: string, input: Evidence) {
  const profile = await prisma.recruiterProfile.findUnique({ where: { userId }, select: { id: true, verifiedBadge: true } });
  if (!profile) throw AppError.notFound("RECRUITER_PROFILE_NOT_FOUND", "Set up your recruiter profile first");
  if (profile.verifiedBadge) throw AppError.conflict("ALREADY_VERIFIED", "You're already verified");
  const evidenceImages = resolveImages(userId, input);
  try {
    return toStatus(await prisma.verificationRequest.create({
      data: { kind: "RECRUITER", submitterId: userId, recruiterProfileId: profile.id, note: input.note ?? null, evidenceLinks: [...new Set(input.evidenceLinks)], evidenceImages },
    }));
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("VERIFICATION_PENDING", "You already have a request waiting for review");
    throw err;
  }
}

export async function latestRecruiter(userId: string) {
  const v = await prisma.verificationRequest.findFirst({ where: { submitterId: userId, kind: "RECRUITER" }, orderBy: { createdAt: "desc" } });
  return v && toStatus(v);
}

// ───────────────────────── player stats ─────────────────────────

async function ownSport(userId: string, sportId: number) {
  const sp = await prisma.playerSport.findFirst({ where: { sportId, profile: { userId } }, select: { id: true, stats: true, statsVerifiedAt: true } });
  if (!sp) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "You haven't added that sport");
  return sp;
}

export async function submitStats(userId: string, sportId: number, input: Evidence) {
  const sp = await ownSport(userId, sportId);
  if (sp.stats === null) throw AppError.invalid("stats", "Add your stats to this sport profile first");
  if (sp.statsVerifiedAt) throw AppError.conflict("ALREADY_VERIFIED", "These stats are already verified");
  const evidenceImages = resolveImages(userId, input);
  try {
    return toStatus(await prisma.verificationRequest.create({
      data: { kind: "PLAYER_STATS", submitterId: userId, playerSportId: sp.id, note: input.note ?? null, evidenceLinks: [...new Set(input.evidenceLinks)], evidenceImages },
    }));
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("VERIFICATION_PENDING", "You already have a request waiting for review");
    throw err;
  }
}

export async function latestStats(userId: string, sportId: number) {
  const sp = await ownSport(userId, sportId);
  const v = await prisma.verificationRequest.findFirst({ where: { playerSportId: sp.id }, orderBy: { createdAt: "desc" } });
  return v && toStatus(v);
}

// ───────────────────────── admin ─────────────────────────

const adminInclude = {
  submitter: { select: { id: true, name: true, email: true, phone: true } },
  recruiterProfile: { select: { id: true, type: true, organization: true, bio: true, verifiedBadge: true } },
  playerSport: { select: { id: true, stats: true, experienceYears: true, currentTeam: true, sport: { select: { code: true, nameEn: true } }, profile: { select: { id: true, user: { select: { name: true } } } } } },
} satisfies Prisma.VerificationRequestInclude;
type AdminRow = Prisma.VerificationRequestGetPayload<{ include: typeof adminInclude }>;

const toAdmin = (v: AdminRow) => ({
  ...toStatus(v),
  // Admins see the storage-side data too: what exactly is being vouched for.
  reviewNote: v.reviewNote,
  submitter: v.submitter,
  recruiter: v.recruiterProfile,
  playerSport: v.playerSport && { id: v.playerSport.id, sportCode: v.playerSport.sport.code, sportName: v.playerSport.sport.nameEn, profileId: v.playerSport.profile.id, playerName: v.playerSport.profile.user.name, stats: v.playerSport.stats, experienceYears: v.playerSport.experienceYears, currentTeam: v.playerSport.currentTeam },
});

export async function adminList(q: z.infer<typeof adminQuery>) {
  const rows = await prisma.verificationRequest.findMany({
    where: { ...(q.status !== "ALL" && { status: q.status }), ...(q.kind && { kind: q.kind }) },
    include: adminInclude,
    // A review queue is worked oldest-first; history is read newest-first.
    orderBy: q.status === "PENDING" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(q.cursor, q.limit),
  });
  const { items, nextCursor } = toPage(rows, q.limit);
  return { items: items.map(toAdmin), nextCursor };
}

export async function adminReview(adminId: string, id: string, input: z.infer<typeof reviewBody>) {
  const existing = await prisma.verificationRequest.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) throw AppError.notFound("VERIFICATION_NOT_FOUND", "Verification request not found");
  if (existing.status !== "PENDING") throw AppError.conflict("VERIFICATION_ALREADY_REVIEWED", `Already ${existing.status.toLowerCase()}`);

  const row = await prisma.$transaction(async (tx) => {
    // Compare-and-set, so two admins can't both decide the same request.
    const { count } = await tx.verificationRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: input.approve ? "APPROVED" : "REJECTED", reviewedById: adminId, reviewedAt: new Date(), reviewNote: input.note ?? null },
    });
    if (count === 0) throw AppError.conflict("VERIFICATION_ALREADY_REVIEWED", "Someone else just reviewed this");
    const v = await tx.verificationRequest.findUniqueOrThrow({ where: { id }, include: adminInclude });
    if (input.approve) {
      if (v.recruiterProfileId) await tx.recruiterProfile.update({ where: { id: v.recruiterProfileId }, data: { verifiedBadge: true } });
      if (v.playerSportId) await tx.playerSport.update({ where: { id: v.playerSportId }, data: { statsVerifiedAt: new Date() } });
    }
    await tx.adminAction.create({
      data: { adminId, action: input.approve ? "VERIFICATION_APPROVE" : "VERIFICATION_REJECT", targetType: "VERIFICATION", targetId: id, reason: input.note ?? null, metadata: { kind: v.kind } },
    });
    return v;
  });
  notify({ userIds: [row.submitterId], type: "VERIFICATION_RESULT", data: { verificationId: id, kind: row.kind, approved: String(input.approve) }, params: { code: input.approve ? "VERIFICATION_APPROVED" : "VERIFICATION_REJECTED" } });
  return toAdmin(row);
}
