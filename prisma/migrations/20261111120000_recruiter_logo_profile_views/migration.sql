-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PROFILE_VIEWED';

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "profileViewed" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "RecruiterProfile" ADD COLUMN     "logoPublicId" TEXT,
ADD COLUMN     "logoUrl" TEXT;

-- CreateTable
CREATE TABLE "ProfileView" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sportId" INTEGER,

    CONSTRAINT "ProfileView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileView_profileId_createdAt_idx" ON "ProfileView"("profileId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileView_profileId_viewerId_day_key" ON "ProfileView"("profileId", "viewerId", "day");

-- AddForeignKey
ALTER TABLE "ProfileView" ADD CONSTRAINT "ProfileView_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileView" ADD CONSTRAINT "ProfileView_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileView" ADD CONSTRAINT "ProfileView_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "Sport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

