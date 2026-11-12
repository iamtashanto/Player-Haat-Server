ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESULT_CONFIRM_ASKED';
ALTER TABLE "MatchResult" ADD COLUMN "opponentTeamId" TEXT, ADD COLUMN "opponentConfirmedAt" TIMESTAMP(3);
ALTER TABLE "PlayerRequest" ADD COLUMN "opponentTeamId" TEXT;
CREATE INDEX "MatchResult_opponentTeamId_idx" ON "MatchResult"("opponentTeamId");
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_opponentTeamId_fkey" FOREIGN KEY ("opponentTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlayerRequest" ADD CONSTRAINT "PlayerRequest_opponentTeamId_fkey" FOREIGN KEY ("opponentTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
