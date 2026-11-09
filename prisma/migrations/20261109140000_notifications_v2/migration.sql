-- CreateEnum
CREATE TYPE "PushStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'NEARBY_AVAILABLE';
ALTER TYPE "NotificationType" ADD VALUE 'GAME_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'REQUEST_FILLED';
ALTER TYPE "NotificationType" ADD VALUE 'GAME_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "games" BOOLEAN NOT NULL DEFAULT true,
    "messages" BOOLEAN NOT NULL DEFAULT true,
    "recruitment" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "nearbyAvailable" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quietStart" TEXT NOT NULL DEFAULT '23:00',
    "quietEnd" TEXT NOT NULL DEFAULT '07:00',
    "chatInQuietHours" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PushJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PushStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "collapseKey" TEXT,
    "announcementId" TEXT,
    "deviceCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "skipReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "PushJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "recipients" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushJob_status_nextAttemptAt_idx" ON "PushJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PushJob_announcementId_status_idx" ON "PushJob"("announcementId", "status");

-- CreateIndex
CREATE INDEX "PushJob_userId_createdAt_idx" ON "PushJob"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PushJob_createdAt_idx" ON "PushJob"("createdAt");

-- CreateIndex
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushJob" ADD CONSTRAINT "PushJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One still-pending job per (user, collapse key): a burst of chat messages becomes one push.
CREATE UNIQUE INDEX "PushJob_pending_collapse_key" ON "PushJob"("userId", "collapseKey") WHERE "status" = 'PENDING' AND "collapseKey" IS NOT NULL;
