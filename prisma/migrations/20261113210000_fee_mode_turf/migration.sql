CREATE TYPE "FeeMode" AS ENUM ('TOTAL', 'PER_PLAYER');
ALTER TABLE "PlayerRequest" ADD COLUMN "feeMode" "FeeMode" NOT NULL DEFAULT 'TOTAL', ADD COLUMN "isTurf" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "PlayerRequest_isTurf_status_matchAt_idx" ON "PlayerRequest"("isTurf", "status", "matchAt");
