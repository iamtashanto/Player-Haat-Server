CREATE TABLE "Place" (
    "id" SERIAL NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT,
    "kind" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "districtId" INTEGER NOT NULL,
    "upazilaId" INTEGER,
    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Place_upazilaId_idx" ON "Place"("upazilaId");
CREATE INDEX "Place_districtId_idx" ON "Place"("districtId");
CREATE INDEX "Place_nameEn_idx" ON "Place"(lower("nameEn") text_pattern_ops);
ALTER TABLE "Place" ADD CONSTRAINT "Place_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Place" ADD CONSTRAINT "Place_upazilaId_fkey" FOREIGN KEY ("upazilaId") REFERENCES "Upazila"("id") ON DELETE CASCADE ON UPDATE CASCADE;
