import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { assertValidLocation } from "../locations/location.service.js";
import { toMyProfile, toPublicProfile, profileInclude, type FullProfile } from "./players.presenter.js";
import { MAX_ACHIEVEMENTS, type addAchievementBody, type addSportBody, type createProfileBody, type updateProfileBody, type updateSportBody } from "./players.schema.js";
import { parseStats } from "./sport-stats.js";

const NOT_FOUND = "PLAYER_PROFILE_NOT_FOUND";
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function loadMyProfile(userId: string): Promise<FullProfile> {
  const profile = await prisma.playerProfile.findUnique({ where: { userId }, include: profileInclude });
  if (!profile) throw AppError.notFound(NOT_FOUND, "Create your player profile first");
  return profile;
}

export async function getMyProfile(userId: string) {
  return toMyProfile(await loadMyProfile(userId));
}

export async function createProfile(userId: string, input: z.infer<typeof createProfileBody>) {
  await assertValidLocation(input);
  try {
    const profile = await prisma.playerProfile.create({
      data: {
        userId,
        bio: input.bio ?? null,
        districtId: input.districtId,
        upazilaId: input.upazilaId,
        unionId: input.unionId ?? null,
        isVisible: input.isVisible ?? true,
      },
      include: profileInclude,
    });
    return toMyProfile(profile);
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("PLAYER_PROFILE_EXISTS", "You already have a player profile");
    throw err;
  }
}

export async function updateProfile(userId: string, patch: z.infer<typeof updateProfileBody>) {
  const existing = await prisma.playerProfile.findUnique({ where: { userId } });
  if (!existing) throw AppError.notFound(NOT_FOUND, "Create your player profile first");

  const districtId = patch.districtId ?? existing.districtId;
  const upazilaId = patch.upazilaId ?? existing.upazilaId;
  // Moving to another upazila drops the old union unless a new one is given; otherwise keep it.
  const unionId = patch.unionId !== undefined ? patch.unionId : patch.upazilaId !== undefined ? null : existing.unionId;
  if (patch.districtId !== undefined || patch.unionId !== undefined) {
    await assertValidLocation({ districtId, upazilaId, unionId });
  }

  const profile = await prisma.playerProfile.update({
    where: { userId },
    data: {
      ...(patch.bio !== undefined && { bio: patch.bio }),
      ...(patch.isVisible !== undefined && { isVisible: patch.isVisible }),
      districtId,
      upazilaId,
      unionId,
      lastActiveAt: new Date(),
    },
    include: profileInclude,
  });
  return toMyProfile(profile);
}

/** Public view: only visible profiles of active users. Hidden ones are indistinguishable from missing. */
export async function getPublicProfile(profileId: string) {
  const profile = await prisma.playerProfile.findFirst({
    where: { id: profileId, isVisible: true, hiddenByAdminAt: null, user: { status: "ACTIVE", role: "PLAYER" } },
    include: profileInclude,
  });
  if (!profile) throw AppError.notFound(NOT_FOUND, "Player not found");
  return toPublicProfile(profile);
}

// ─────────────────────────── sports ───────────────────────────

type SportState = {
  positions: string[];
  preferredFoot: "LEFT" | "RIGHT" | "BOTH" | null;
  battingStyle: "RIGHT_HAND" | "LEFT_HAND" | null;
  skillLevel: number;
  khepAvailable: boolean;
  rateMin: number | null;
  rateMax: number | null;
  availability: Prisma.InputJsonValue | null;
  travelRadius: "UNION" | "UPAZILA" | "DISTRICT";
  headline: string | null;
  experienceYears: number | null;
  currentTeam: string | null;
  stats: Record<string, number> | null;
  isVisible: boolean;
};

/** Rules that depend on which sport it is, or on several fields together. */
function validateSportState(sport: { code: string; positions: { code: string }[] }, s: SportState) {
  const valid = new Set(sport.positions.map((p) => p.code));
  const unknown = s.positions.filter((p) => !valid.has(p));
  if (unknown.length) {
    throw AppError.invalid("positions", `Unknown position(s) for ${sport.code}: ${unknown.join(", ")}. Valid: ${[...valid].join(", ")}`);
  }
  if (s.preferredFoot && sport.code !== "FOOTBALL") throw AppError.invalid("preferredFoot", "Only applies to football");
  if (s.battingStyle && sport.code !== "CRICKET") throw AppError.invalid("battingStyle", "Only applies to cricket");
  if (!s.khepAvailable && (s.rateMin !== null || s.rateMax !== null)) {
    throw AppError.invalid("khepAvailable", "Rates can only be set when khepAvailable is true");
  }
  if (s.rateMin !== null && s.rateMax !== null && s.rateMin > s.rateMax) {
    throw AppError.invalid("rateMin", "rateMin must be ≤ rateMax");
  }
  s.stats = parseStats(sport.code, s.stats); // per-sport shape; normalises {} to null
}

/** Drops empty days and duplicate slots so stored availability is canonical (and day filters are exact). */
function normalizeAvailability(a: Record<string, string[] | undefined> | null | undefined) {
  if (!a) return null;
  const out: Record<string, string[]> = {};
  for (const [day, slots] of Object.entries(a)) {
    const unique = [...new Set(slots ?? [])];
    if (unique.length) out[day] = unique;
  }
  return Object.keys(out).length ? out : null;
}

const toDb = (v: Prisma.InputJsonValue | null) => (v === null ? Prisma.DbNull : v);
/** Json columns need DbNull (not null) to clear; everything else in SportState maps straight onto the row. */
const toRow = (s: SportState) => ({ ...s, availability: toDb(s.availability), stats: toDb(s.stats) });

async function loadActiveSport(sportId: number) {
  const sport = await prisma.sport.findFirst({
    where: { id: sportId, isActive: true },
    select: { id: true, code: true, positions: { select: { code: true } } },
  });
  if (!sport) throw AppError.invalid("sportId", "Unknown or inactive sport");
  return sport;
}

async function profileIdOf(userId: string) {
  const p = await prisma.playerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!p) throw AppError.notFound(NOT_FOUND, "Create your player profile first");
  return p.id;
}

export async function addSport(userId: string, input: z.infer<typeof addSportBody>) {
  const profileId = await profileIdOf(userId);
  const sport = await loadActiveSport(input.sportId);
  const state: SportState = {
    positions: [...new Set(input.positions)],
    preferredFoot: input.preferredFoot ?? null,
    battingStyle: input.battingStyle ?? null,
    skillLevel: input.skillLevel,
    khepAvailable: input.khepAvailable ?? false,
    rateMin: input.rateMin ?? null,
    rateMax: input.rateMax ?? null,
    availability: normalizeAvailability(input.availability),
    travelRadius: input.travelRadius ?? "UPAZILA",
    headline: input.headline ?? null,
    experienceYears: input.experienceYears ?? null,
    currentTeam: input.currentTeam ?? null,
    stats: input.stats ?? null,
    isVisible: input.isVisible ?? true,
  };
  validateSportState(sport, state);

  try {
    await prisma.playerSport.create({ data: { profileId, sportId: sport.id, ...toRow(state) } });
  } catch (err) {
    if (isUnique(err)) throw AppError.conflict("PLAYER_SPORT_EXISTS", "You already added that sport; update it instead");
    throw err;
  }
  await touch(profileId);
  return getMyProfile(userId);
}

export async function updateSport(userId: string, sportId: number, patch: z.infer<typeof updateSportBody>) {
  const profileId = await profileIdOf(userId);
  const existing = await prisma.playerSport.findUnique({
    where: { profileId_sportId: { profileId, sportId } },
    include: { sport: { select: { code: true, positions: { select: { code: true } } } } },
  });
  if (!existing) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "You haven't added that sport");

  const khepAvailable = patch.khepAvailable ?? existing.khepAvailable;
  const state: SportState = {
    positions: patch.positions ? [...new Set(patch.positions)] : existing.positions,
    preferredFoot: patch.preferredFoot !== undefined ? patch.preferredFoot : existing.preferredFoot,
    battingStyle: patch.battingStyle !== undefined ? patch.battingStyle : existing.battingStyle,
    skillLevel: patch.skillLevel ?? existing.skillLevel,
    khepAvailable,
    // Turning khep off clears the rates unless the caller says otherwise (which validation will then reject).
    rateMin: patch.rateMin !== undefined ? patch.rateMin : khepAvailable ? existing.rateMin : null,
    rateMax: patch.rateMax !== undefined ? patch.rateMax : khepAvailable ? existing.rateMax : null,
    availability: patch.availability !== undefined ? normalizeAvailability(patch.availability) : (existing.availability as Prisma.InputJsonValue | null),
    travelRadius: patch.travelRadius ?? existing.travelRadius,
    headline: patch.headline !== undefined ? patch.headline : existing.headline,
    experienceYears: patch.experienceYears !== undefined ? patch.experienceYears : existing.experienceYears,
    currentTeam: patch.currentTeam !== undefined ? patch.currentTeam : existing.currentTeam,
    stats: patch.stats !== undefined ? patch.stats : (existing.stats as Record<string, number> | null),
    isVisible: patch.isVisible ?? existing.isVisible,
  };
  validateSportState(existing.sport, state);

  await prisma.playerSport.update({ where: { id: existing.id }, data: toRow(state) });
  await touch(profileId);
  return getMyProfile(userId);
}

export async function removeSport(userId: string, sportId: number) {
  const profileId = await profileIdOf(userId);
  const { count } = await prisma.playerSport.deleteMany({ where: { profileId, sportId } });
  if (count === 0) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "You haven't added that sport");
  return getMyProfile(userId);
}

// ─────────────────────────── achievements ───────────────────────────

/** The caller's own sport profile, or 404 — ownership is enforced by looking it up through their profile. */
async function ownSportRow(userId: string, sportId: number) {
  const row = await prisma.playerSport.findFirst({ where: { sportId, profile: { userId } }, select: { id: true, profileId: true } });
  if (!row) throw AppError.notFound("PLAYER_SPORT_NOT_FOUND", "You haven't added that sport");
  return row;
}

export async function addAchievement(userId: string, sportId: number, input: z.infer<typeof addAchievementBody>) {
  const row = await ownSportRow(userId, sportId);
  await prisma.$transaction(async (tx) => {
    // Lock the sport profile row so two concurrent adds can't both slip past the cap.
    await tx.$queryRaw`SELECT id FROM "PlayerSport" WHERE id = ${row.id} FOR UPDATE`;
    if ((await tx.playerAchievement.count({ where: { playerSportId: row.id } })) >= MAX_ACHIEVEMENTS) {
      throw AppError.conflict("PLAYER_ACHIEVEMENT_LIMIT", `You can list up to ${MAX_ACHIEVEMENTS} achievements per sport`);
    }
    await tx.playerAchievement.create({
      data: { playerSportId: row.id, title: input.title, year: input.year ?? null, description: input.description ?? null },
    });
  });
  await touch(row.profileId);
  return getMyProfile(userId);
}

export async function removeAchievement(userId: string, sportId: number, achievementId: string) {
  const row = await ownSportRow(userId, sportId);
  const { count } = await prisma.playerAchievement.deleteMany({ where: { id: achievementId, playerSportId: row.id } });
  if (count === 0) throw AppError.notFound("PLAYER_ACHIEVEMENT_NOT_FOUND", "Achievement not found");
  return getMyProfile(userId);
}

const touch = (profileId: string) =>
  prisma.playerProfile.update({ where: { id: profileId }, data: { lastActiveAt: new Date() } });
