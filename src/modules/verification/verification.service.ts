import type { Prisma, VerificationRequest } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { cursorArgs, toPage } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { randomUUID } from "node:crypto";
import { decryptEvidence, encryptEvidence } from "../../lib/evidence-crypto.js";
import { stripImageMetadata } from "../../lib/image-meta.js";
import { imageSize } from "../../lib/image-size.js";
import { sniffImageType } from "../../lib/image-sniff.js";
import { storage } from "../../lib/storage/index.js";
import { deleteImagesQuietly } from "../../lib/storage/safe-delete.js";
import { notify } from "../notifications/notifier.js";
import type { adminQuery, reviewBody, submitRecruiterBody } from "./verification.schema.js";

type Evidence = z.infer<typeof submitRecruiterBody>;
type FileRow = { id: string; mime: string; width: number | null; height: number | null };
type WithFiles = VerificationRequest & { files: FileRow[] };

const filesOf = (v: WithFiles) => v.files.map((f) => ({ id: f.id, mime: f.mime, width: f.width, height: f.height }));

function toStatus(v: WithFiles) {
  return {
    id: v.id,
    kind: v.kind,
    status: v.status,
    note: v.note,
    evidenceLinks: v.evidenceLinks,
    files: filesOf(v), // ids only: a document has no URL
    reviewNote: v.status === "REJECTED" ? v.reviewNote : null,
    createdAt: v.createdAt.toISOString(),
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
  };
}

const withFiles = { files: { select: { id: true, mime: true, width: true, height: true }, orderBy: { createdAt: "asc" } } } satisfies Prisma.VerificationRequestInclude;

// ───────────────────────── private documents ─────────────────────────

/** Encrypts and stores one document under `verification/<userId>/`. Returns facts only; there is no URL to give. */
export async function uploadFile(userId: string, buffer: Buffer) {
  const mime = sniffImageType(buffer);
  if (!mime || mime === "image/heic") throw new AppError("MEDIA_UNSUPPORTED_TYPE", 415, "Documents must be jpeg, png or webp images");
  if (!storage.putText) throw new AppError("STORAGE_NOT_CONFIGURED", 503, "Document storage isn't set up on this server");
  const clean = stripImageMetadata(buffer, mime);
  const size = imageSize(clean, mime);
  const cipher = encryptEvidence(clean, userId);
  const stored = await storage.putText(cipher, { folder: `verification/${userId}`, name: randomUUID() });
  try {
    const f = await prisma.verificationFile.create({
      data: { userId, path: stored.path, mediaId: stored.mediaId ?? null, mime, width: size?.width ?? null, height: size?.height ?? null, size: clean.length },
      select: { id: true, mime: true, width: true, height: true },
    });
    return f;
  } catch (err) {
    await deleteImagesQuietly([stored.path]);
    throw err;
  }
}

async function readFile(f: { userId: string; path: string; mime: string }) {
  if (!storage.getText) throw new AppError("STORAGE_NOT_CONFIGURED", 503, "Document storage isn't set up on this server");
  return { bytes: decryptEvidence(await storage.getText(f.path), f.userId), mime: f.mime };
}

/** The submitter opens their own upload — attached or not. Everyone else gets a 404, as if it did not exist. */
export async function ownFile(userId: string, fileId: string) {
  const f = await prisma.verificationFile.findFirst({ where: { id: fileId, userId } });
  if (!f) throw AppError.notFound("VERIFICATION_FILE_NOT_FOUND", "Document not found");
  return readFile(f);
}

/** An admin opens a document of a request. Every view is audit-logged. */
export async function adminFile(adminId: string, requestId: string, fileId: string) {
  const f = await prisma.verificationFile.findFirst({ where: { id: fileId, requestId } });
  if (!f) throw AppError.notFound("VERIFICATION_FILE_NOT_FOUND", "Document not found");
  const out = await readFile(f);
  await prisma.adminAction.create({ data: { adminId, action: "VERIFICATION_FILE_VIEW", targetType: "VERIFICATION", targetId: requestId, metadata: { fileId, ownerId: f.userId } } });
  return out;
}

/** Each id must be the submitter's own, still-unattached upload. */
async function claimFiles(tx: Prisma.TransactionClient, userId: string, requestId: string, input: Evidence) {
  const ids = [...new Set(input.fileIds)];
  if (ids.length === 0) return;
  const { count } = await tx.verificationFile.updateMany({ where: { id: { in: ids }, userId, requestId: null }, data: { requestId } });
  if (count !== ids.length) throw AppError.invalid("fileIds", "Upload each document with POST /verification/files first");
}

const isUnique = (e: unknown) => (e as Prisma.PrismaClientKnownRequestError).code === "P2002";

// ───────────────────────── recruiters ─────────────────────────

export async function submitRecruiter(userId: string, input: Evidence) {
  const profile = await prisma.recruiterProfile.findUnique({ where: { userId }, select: { id: true, verifiedBadge: true } });
  if (!profile) throw AppError.notFound("RECRUITER_PROFILE_NOT_FOUND", "Set up your recruiter profile first");
  if (profile.verifiedBadge) throw AppError.conflict("ALREADY_VERIFIED", "You're already verified");
  try {
    return toStatus(await prisma.$transaction(async (tx) => {
      const v = await tx.verificationRequest.create({ data: { kind: "RECRUITER", submitterId: userId, recruiterProfileId: profile.id, note: input.note ?? null, evidenceLinks: [...new Set(input.evidenceLinks)] } });
      await claimFiles(tx, userId, v.id, input);
      return tx.verificationRequest.findUniqueOrThrow({ where: { id: v.id }, include: withFiles });
    }));
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("VERIFICATION_PENDING", "You already have a request waiting for review");
    throw err;
  }
}

export async function latestRecruiter(userId: string) {
  const v = await prisma.verificationRequest.findFirst({ where: { submitterId: userId, kind: "RECRUITER" }, orderBy: { createdAt: "desc" }, include: withFiles });
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
  try {
    return toStatus(await prisma.$transaction(async (tx) => {
      const v = await tx.verificationRequest.create({ data: { kind: "PLAYER_STATS", submitterId: userId, playerSportId: sp.id, note: input.note ?? null, evidenceLinks: [...new Set(input.evidenceLinks)] } });
      await claimFiles(tx, userId, v.id, input);
      return tx.verificationRequest.findUniqueOrThrow({ where: { id: v.id }, include: withFiles });
    }));
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("VERIFICATION_PENDING", "You already have a request waiting for review");
    throw err;
  }
}

export async function latestStats(userId: string, sportId: number) {
  const sp = await ownSport(userId, sportId);
  const v = await prisma.verificationRequest.findFirst({ where: { playerSportId: sp.id }, orderBy: { createdAt: "desc" }, include: withFiles });
  return v && toStatus(v);
}

// ───────────────────────── admin ─────────────────────────

const adminInclude = {
  ...withFiles,
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
