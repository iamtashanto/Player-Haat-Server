-- CreateTable
CREATE TABLE "PlayerAvailability" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sportId" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerAvailability_profileId_sportId_key" ON "PlayerAvailability"("profileId", "sportId");
CREATE INDEX "PlayerAvailability_sportId_endsAt_idx" ON "PlayerAvailability"("sportId", "endsAt");
CREATE INDEX "PlayerAvailability_endsAt_idx" ON "PlayerAvailability"("endsAt");

-- AddForeignKey
ALTER TABLE "PlayerAvailability" ADD CONSTRAINT "PlayerAvailability_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerAvailability" ADD CONSTRAINT "PlayerAvailability_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "Sport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A window must end after it starts.
ALTER TABLE "PlayerAvailability" ADD CONSTRAINT "PlayerAvailability_window_check" CHECK ("endsAt" > "startsAt");
