ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'WAITLISTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WAITLIST_PROMOTED';
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "waitlistedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Application_requestId_status_waitlistedAt_idx" ON "Application"("requestId", "status", "waitlistedAt");
