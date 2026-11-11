-- AlterEnum
ALTER TYPE "AdminActionType" ADD VALUE 'VERIFICATION_FILE_VIEW';

-- CreateTable
CREATE TABLE "MediaAsset" (
    "path" TEXT NOT NULL,
    "mediaId" TEXT,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "VerificationFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT,
    "path" TEXT NOT NULL,
    "mediaId" TEXT,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_mediaId_idx" ON "MediaAsset"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationFile_path_key" ON "VerificationFile"("path");

-- CreateIndex
CREATE INDEX "VerificationFile_requestId_idx" ON "VerificationFile"("requestId");

-- CreateIndex
CREATE INDEX "VerificationFile_userId_createdAt_idx" ON "VerificationFile"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "VerificationFile" ADD CONSTRAINT "VerificationFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationFile" ADD CONSTRAINT "VerificationFile_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "VerificationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

