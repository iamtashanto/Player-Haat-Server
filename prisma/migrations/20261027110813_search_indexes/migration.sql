-- DropIndex
DROP INDEX "PlayerProfile_avgRating_ratingCount_idx";

-- DropIndex
DROP INDEX "PlayerProfile_districtId_isVisible_idx";

-- DropIndex
DROP INDEX "PlayerProfile_lastActiveAt_idx";

-- DropIndex
DROP INDEX "PlayerProfile_upazilaId_isVisible_idx";

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "PlayerProfile_upazilaId_avgRating_ratingCount_id_idx" ON "PlayerProfile"("upazilaId", "avgRating" DESC, "ratingCount" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerProfile_districtId_avgRating_ratingCount_id_idx" ON "PlayerProfile"("districtId", "avgRating" DESC, "ratingCount" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerProfile_upazilaId_lastActiveAt_id_idx" ON "PlayerProfile"("upazilaId", "lastActiveAt" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerProfile_districtId_lastActiveAt_id_idx" ON "PlayerProfile"("districtId", "lastActiveAt" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerProfile_avgRating_ratingCount_id_idx" ON "PlayerProfile"("avgRating" DESC, "ratingCount" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerProfile_lastActiveAt_id_idx" ON "PlayerProfile"("lastActiveAt" DESC, "id");

-- CreateIndex
CREATE INDEX "PlayerRequest_status_completedAt_idx" ON "PlayerRequest"("status", "completedAt");
