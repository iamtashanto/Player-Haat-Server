-- CreateEnum
CREATE TYPE "JoinMode" AS ENUM ('APPROVAL', 'OPEN_JOIN');

-- CreateEnum
CREATE TYPE "Attendance" AS ENUM ('ATTENDED', 'NO_SHOW');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "attendance" "Attendance",
ADD COLUMN     "attendanceMarkedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlayerRequest" ADD COLUMN     "joinMode" "JoinMode" NOT NULL DEFAULT 'APPROVAL';

-- CreateTable
CREATE TABLE "GameMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameMessage_requestId_createdAt_idx" ON "GameMessage"("requestId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Application_playerId_attendance_idx" ON "Application"("playerId", "attendance");

-- AddForeignKey
ALTER TABLE "GameMessage" ADD CONSTRAINT "GameMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PlayerRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameMessage" ADD CONSTRAINT "GameMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

