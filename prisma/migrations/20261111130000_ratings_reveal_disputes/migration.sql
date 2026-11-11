-- Double-blind reveal, public replies, admin hiding, disputes and a damped rating for ordering.
ALTER TABLE "Rating" ADD COLUMN "revealedAt" TIMESTAMP(3), ADD COLUMN "replyText" TEXT, ADD COLUMN "repliedAt" TIMESTAMP(3), ADD COLUMN "hiddenByAdminAt" TIMESTAMP(3);
-- Everything that exists today was already visible.
UPDATE "Rating" SET "revealedAt" = "createdAt";
CREATE INDEX "Rating_revealedAt_idx" ON "Rating"("revealedAt");

ALTER TABLE "PlayerProfile" ADD COLUMN "bayesRating" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX "PlayerProfile_bayesRating_ratingCount_id_idx" ON "PlayerProfile"("bayesRating" DESC, "ratingCount" DESC, "id");

CREATE TYPE "RatingDisputeStatus" AS ENUM ('OPEN', 'UPHELD', 'REMOVED');
CREATE TABLE "RatingDispute" (
  "id" TEXT NOT NULL,
  "ratingId" TEXT NOT NULL,
  "disputerId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "photoPublicId" TEXT,
  "status" "RatingDisputeStatus" NOT NULL DEFAULT 'OPEN',
  "adminNote" TEXT,
  "resolvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "RatingDispute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RatingDispute_ratingId_key" ON "RatingDispute"("ratingId");
CREATE INDEX "RatingDispute_status_createdAt_idx" ON "RatingDispute"("status", "createdAt");
ALTER TABLE "RatingDispute" ADD CONSTRAINT "RatingDispute_ratingId_fkey" FOREIGN KEY ("ratingId") REFERENCES "Rating"("id") ON DELETE CASCADE ON UPDATE CASCADE;
