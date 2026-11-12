ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SERIES_GAME_POSTED';

CREATE TABLE "GameSeries" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sportId" INTEGER NOT NULL,
    "districtId" INTEGER NOT NULL,
    "upazilaId" INTEGER NOT NULL,
    "unionId" INTEGER,
    "venueText" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "positionsNeeded" TEXT[],
    "playersNeeded" INTEGER NOT NULL DEFAULT 1,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "budgetMin" INTEGER,
    "budgetMax" INTEGER,
    "notes" TEXT,
    "joinMode" "JoinMode" NOT NULL DEFAULT 'APPROVAL',
    "teamId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GameSeries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeriesMember" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeriesMember_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlayerRequest" ADD COLUMN "seriesId" TEXT;

CREATE INDEX "GameSeries_createdById_idx" ON "GameSeries"("createdById");
CREATE INDEX "GameSeries_isActive_idx" ON "GameSeries"("isActive");
CREATE UNIQUE INDEX "SeriesMember_seriesId_userId_key" ON "SeriesMember"("seriesId", "userId");
CREATE INDEX "SeriesMember_userId_idx" ON "SeriesMember"("userId");
CREATE INDEX "PlayerRequest_seriesId_matchAt_idx" ON "PlayerRequest"("seriesId", "matchAt");

ALTER TABLE "GameSeries" ADD CONSTRAINT "GameSeries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameSeries" ADD CONSTRAINT "GameSeries_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "Sport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameSeries" ADD CONSTRAINT "GameSeries_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameSeries" ADD CONSTRAINT "GameSeries_upazilaId_fkey" FOREIGN KEY ("upazilaId") REFERENCES "Upazila"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameSeries" ADD CONSTRAINT "GameSeries_unionId_fkey" FOREIGN KEY ("unionId") REFERENCES "Union"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SeriesMember" ADD CONSTRAINT "SeriesMember_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "GameSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeriesMember" ADD CONSTRAINT "SeriesMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerRequest" ADD CONSTRAINT "PlayerRequest_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "GameSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
