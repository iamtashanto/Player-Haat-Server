
-- CreateEnum
CREATE TYPE "ContactVisibility" AS ENUM ('ON_TAP', 'AFTER_ACCEPT');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RequestKind" AS ENUM ('MATCH', 'EVENT');

-- CreateEnum
CREATE TYPE "VerificationKind" AS ENUM ('RECRUITER', 'PLAYER_STATS');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('PURCHASE', 'CONTACT_REVEAL', 'BOOST', 'ADMIN_GRANT', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('SANDBOX', 'BKASH', 'NAGAD', 'ROCKET');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PAID', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminActionType" ADD VALUE 'VERIFICATION_APPROVE';
ALTER TYPE "AdminActionType" ADD VALUE 'VERIFICATION_REJECT';
ALTER TYPE "AdminActionType" ADD VALUE 'PAYMENT_APPROVE';
ALTER TYPE "AdminActionType" ADD VALUE 'PAYMENT_REJECT';
ALTER TYPE "AdminActionType" ADD VALUE 'CREDITS_GRANT';
ALTER TYPE "AdminActionType" ADD VALUE 'CREDIT_PACK_SET';
ALTER TYPE "AdminActionType" ADD VALUE 'CONVERSATION_VIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'INVITE_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'INVITE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'INVITE_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTACT_VIEWED';
ALTER TYPE "NotificationType" ADD VALUE 'NEW_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'VERIFICATION_RESULT';
ALTER TYPE "NotificationType" ADD VALUE 'TEAM_JOINED';

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'CONVERSATION';

-- AlterTable
ALTER TABLE "PlayerProfile" ADD COLUMN     "contactVisibility" "ContactVisibility" NOT NULL DEFAULT 'ON_TAP';

-- AlterTable
ALTER TABLE "PlayerRequest" ADD COLUMN     "kind" "RequestKind" NOT NULL DEFAULT 'MATCH',
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "PlayerSport" ADD COLUMN     "statsVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "joinCode" TEXT;
UPDATE "Team" SET "joinCode" = upper(substr(md5(random()::text || id), 1, 8)) WHERE "joinCode" IS NULL;
ALTER TABLE "Team" ALTER COLUMN "joinCode" SET NOT NULL;
ALTER TABLE "Team" ALTER COLUMN "joinCode" SET DEFAULT upper(substr(md5(((random())::text || (clock_timestamp())::text)), 1, 8));

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ContactReveal" (
    "id" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactReveal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "recruiterId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sportId" INTEGER,
    "requestId" TEXT,
    "message" TEXT,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortlistEntry" (
    "id" TEXT NOT NULL,
    "recruiterId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRequest" (
    "id" TEXT NOT NULL,
    "kind" "VerificationKind" NOT NULL,
    "submitterId" TEXT NOT NULL,
    "recruiterProfileId" TEXT,
    "playerSportId" TEXT,
    "note" TEXT,
    "evidenceLinks" TEXT[],
    "evidenceImages" JSONB,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPack" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceBdt" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amountBdt" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "trxId" TEXT,
    "senderNumber" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "recruiterId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT,
    "recruiterUnread" INTEGER NOT NULL DEFAULT 0,
    "playerUnread" INTEGER NOT NULL DEFAULT 0,
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactReveal_profileId_createdAt_idx" ON "ContactReveal"("profileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ContactReveal_viewerId_createdAt_idx" ON "ContactReveal"("viewerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ContactReveal_viewerId_profileId_key" ON "ContactReveal"("viewerId", "profileId");

-- CreateIndex
CREATE INDEX "Invite_profileId_status_createdAt_idx" ON "Invite"("profileId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Invite_recruiterId_createdAt_idx" ON "Invite"("recruiterId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ShortlistEntry_recruiterId_createdAt_idx" ON "ShortlistEntry"("recruiterId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ShortlistEntry_recruiterId_profileId_key" ON "ShortlistEntry"("recruiterId", "profileId");

-- CreateIndex
CREATE INDEX "VerificationRequest_status_createdAt_idx" ON "VerificationRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationRequest_submitterId_createdAt_idx" ON "VerificationRequest"("submitterId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPack_code_key" ON "CreditPack"("code");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_method_trxId_key" ON "Payment"("method", "trxId");

-- CreateIndex
CREATE INDEX "Conversation_recruiterId_lastMessageAt_idx" ON "Conversation"("recruiterId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_playerId_lastMessageAt_idx" ON "Conversation"("playerId", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_recruiterId_playerId_key" ON "Conversation"("recruiterId", "playerId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Team_joinCode_key" ON "Team"("joinCode");

-- AddForeignKey
ALTER TABLE "ContactReveal" ADD CONSTRAINT "ContactReveal_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactReveal" ADD CONSTRAINT "ContactReveal_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PlayerRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortlistEntry" ADD CONSTRAINT "ShortlistEntry_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortlistEntry" ADD CONSTRAINT "ShortlistEntry_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRequest" ADD CONSTRAINT "VerificationRequest_submitterId_fkey" FOREIGN KEY ("submitterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRequest" ADD CONSTRAINT "VerificationRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRequest" ADD CONSTRAINT "VerificationRequest_recruiterProfileId_fkey" FOREIGN KEY ("recruiterProfileId") REFERENCES "RecruiterProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRequest" ADD CONSTRAINT "VerificationRequest_playerSportId_fkey" FOREIGN KEY ("playerSportId") REFERENCES "PlayerSport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packId_fkey" FOREIGN KEY ("packId") REFERENCES "CreditPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Integrity backstops (Zod is the first line; these catch anything that bypasses the API) ───
ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_nonneg" CHECK ("creditBalance" >= 0);
ALTER TABLE "CreditPack" ADD CONSTRAINT "CreditPack_positive" CHECK ("credits" > 0 AND "priceBdt" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive" CHECK ("credits" > 0 AND "amountBdt" > 0);
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_balance_nonneg" CHECK ("balanceAfter" >= 0 AND "delta" <> 0);
ALTER TABLE "ContactReveal" ADD CONSTRAINT "ContactReveal_cost_nonneg" CHECK ("cost" >= 0);
ALTER TABLE "Message" ADD CONSTRAINT "Message_body_len" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_distinct_people" CHECK ("recruiterId" <> "playerId");
ALTER TABLE "VerificationRequest" ADD CONSTRAINT "VerificationRequest_target" CHECK (
  ("kind" = 'RECRUITER' AND "recruiterProfileId" IS NOT NULL AND "playerSportId" IS NULL) OR
  ("kind" = 'PLAYER_STATS' AND "playerSportId" IS NOT NULL AND "recruiterProfileId" IS NULL)
);

-- ─── One open item per target (partial unique indexes Prisma can't declare) ───
CREATE UNIQUE INDEX "Invite_one_pending_per_pair" ON "Invite"("recruiterId", "profileId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "VerificationRequest_one_pending_recruiter" ON "VerificationRequest"("recruiterProfileId") WHERE "status" = 'PENDING' AND "recruiterProfileId" IS NOT NULL;
CREATE UNIQUE INDEX "VerificationRequest_one_pending_stats" ON "VerificationRequest"("playerSportId") WHERE "status" = 'PENDING' AND "playerSportId" IS NOT NULL;
CREATE INDEX "PlayerRequest_boostedUntil_idx" ON "PlayerRequest"("boostedUntil") WHERE "boostedUntil" IS NOT NULL;

-- ─── Starter credit packs (admins can change prices and add packs from the dashboard) ───
INSERT INTO "CreditPack" ("id", "code", "credits", "priceBdt", "isActive", "order") VALUES
  ('pack_starter', 'STARTER', 10, 99, true, 1),
  ('pack_plus', 'PLUS', 30, 249, true, 2),
  ('pack_pro', 'PRO', 100, 699, true, 3);
