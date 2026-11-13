CREATE TABLE "PostOffice" (
    "id" SERIAL NOT NULL,
    "upazilaId" INTEGER NOT NULL,
    "nameEn" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    CONSTRAINT "PostOffice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PostOffice_code_idx" ON "PostOffice"("code");
CREATE INDEX "PostOffice_upazilaId_idx" ON "PostOffice"("upazilaId");
ALTER TABLE "PostOffice" ADD CONSTRAINT "PostOffice_upazilaId_fkey" FOREIGN KEY ("upazilaId") REFERENCES "Upazila"("id") ON DELETE CASCADE ON UPDATE CASCADE;
