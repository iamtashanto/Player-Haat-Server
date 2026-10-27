-- Roles: USER → PLAYER, plus RECRUITER. Existing accounts keep working as players.

-- CreateEnum
CREATE TYPE "RecruiterType" AS ENUM ('CLUB', 'ACADEMY', 'SCOUT', 'AGENT', 'ORGANIZER', 'OTHER');

-- AlterEnum (new audit-log actions)
ALTER TYPE "AdminActionType" ADD VALUE 'SPORT_PROFILE_HIDE';
ALTER TYPE "AdminActionType" ADD VALUE 'SPORT_PROFILE_UNHIDE';
ALTER TYPE "AdminActionType" ADD VALUE 'RECRUITER_VERIFY';
ALTER TYPE "AdminActionType" ADD VALUE 'RECRUITER_UNVERIFY';
ALTER TYPE "AdminActionType" ADD VALUE 'USER_ROLE_CHANGE';

-- AlterEnum (UserRole): the cast maps the retired 'USER' value, which a plain ::text cast would reject.
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('PLAYER', 'RECRUITER', 'ADMIN');
ALTER TABLE "public"."User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new"
  USING (CASE "role"::text WHEN 'USER' THEN 'PLAYER' ELSE "role"::text END)::"UserRole_new";
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'PLAYER';
COMMIT;

-- AlterTable: a sport profile is a PlayerSport row; give it its own story, visibility and rating.
ALTER TABLE "PlayerSport" ADD COLUMN     "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "currentTeam" TEXT,
ADD COLUMN     "experienceYears" INTEGER,
ADD COLUMN     "headline" TEXT,
ADD COLUMN     "hiddenByAdminAt" TIMESTAMP(3),
ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stats" JSONB;

-- CreateTable
CREATE TABLE "PlayerAchievement" (
    "id" TEXT NOT NULL,
    "playerSportId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruiterProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "RecruiterType" NOT NULL,
    "organization" TEXT,
    "bio" TEXT,
    "districtId" INTEGER NOT NULL,
    "sportIds" INTEGER[],
    "verifiedBadge" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruiterProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlayerAchievement_playerSportId_year_idx" ON "PlayerAchievement"("playerSportId", "year" DESC);
CREATE UNIQUE INDEX "RecruiterProfile_userId_key" ON "RecruiterProfile"("userId");
CREATE INDEX "RecruiterProfile_districtId_idx" ON "RecruiterProfile"("districtId");
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- AddForeignKey
ALTER TABLE "PlayerAchievement" ADD CONSTRAINT "PlayerAchievement_playerSportId_fkey" FOREIGN KEY ("playerSportId") REFERENCES "PlayerSport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecruiterProfile" ADD CONSTRAINT "RecruiterProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecruiterProfile" ADD CONSTRAINT "RecruiterProfile_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data-integrity backstops (Zod is the first line; these catch anything that bypasses the API).
ALTER TABLE "PlayerSport" ADD CONSTRAINT "PlayerSport_experienceYears_range" CHECK ("experienceYears" IS NULL OR ("experienceYears" BETWEEN 0 AND 60));
ALTER TABLE "PlayerSport" ADD CONSTRAINT "PlayerSport_ratingCount_nonneg" CHECK ("ratingCount" >= 0 AND "avgRating" BETWEEN 0 AND 5);
ALTER TABLE "PlayerAchievement" ADD CONSTRAINT "PlayerAchievement_year_range" CHECK ("year" IS NULL OR ("year" BETWEEN 1950 AND 2100));
ALTER TABLE "PlayerAchievement" ADD CONSTRAINT "PlayerAchievement_title_len" CHECK (char_length("title") BETWEEN 1 AND 100);

-- Backfill per-sport ratings from the reviews already on file (no-shows are strikes, not reviews).
UPDATE "PlayerSport" ps
SET "avgRating" = agg.avg, "ratingCount" = agg.cnt
FROM (
  SELECT pp.id AS "profileId", req."sportId", AVG(r.overall) AS avg, COUNT(*)::int AS cnt
  FROM "Rating" r
  JOIN "PlayerRequest" req ON req.id = r."requestId"
  JOIN "PlayerProfile" pp ON pp."userId" = r."rateeId"
  WHERE r.direction = 'CAPTAIN_TO_PLAYER' AND r."noShow" = false
  GROUP BY pp.id, req."sportId"
) agg
WHERE ps."profileId" = agg."profileId" AND ps."sportId" = agg."sportId";
