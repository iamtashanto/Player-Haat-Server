ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESULT_POSTED';

CREATE TABLE "MatchResult" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "ourScore" INTEGER NOT NULL,
    "theirScore" INTEGER NOT NULL,
    "opponentName" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MatchResult_requestId_key" ON "MatchResult"("requestId");
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PlayerRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
