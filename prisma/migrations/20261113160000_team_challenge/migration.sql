CREATE TYPE "ChallengeStatus" AS ENUM ('OPEN', 'ACCEPTED', 'CANCELLED');

CREATE TABLE "TeamChallenge" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sportId" INTEGER NOT NULL,
    "districtId" INTEGER NOT NULL,
    "upazilaId" INTEGER NOT NULL,
    "venueText" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedByTeamId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamChallenge_status_proposedAt_idx" ON "TeamChallenge"("status", "proposedAt");
CREATE INDEX "TeamChallenge_upazilaId_status_proposedAt_idx" ON "TeamChallenge"("upazilaId", "status", "proposedAt");
CREATE INDEX "TeamChallenge_teamId_idx" ON "TeamChallenge"("teamId");
ALTER TABLE "TeamChallenge" ADD CONSTRAINT "TeamChallenge_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamChallenge" ADD CONSTRAINT "TeamChallenge_acceptedByTeamId_fkey" FOREIGN KEY ("acceptedByTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
