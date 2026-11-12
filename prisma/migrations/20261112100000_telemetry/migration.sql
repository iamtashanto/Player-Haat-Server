CREATE TYPE "TelemetryKind" AS ENUM ('ERROR', 'EVENT');
CREATE TABLE "TelemetryEvent" (
  "id" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" "TelemetryKind" NOT NULL,
  "name" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "appVersion" TEXT,
  "sessionId" TEXT NOT NULL,
  "route" TEXT,
  "message" TEXT,
  "stack" TEXT,
  "fingerprint" TEXT,
  "props" JSONB,
  "locale" TEXT,
  CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TelemetryEvent_kind_at_idx" ON "TelemetryEvent"("kind", "at");
CREATE INDEX "TelemetryEvent_kind_name_at_idx" ON "TelemetryEvent"("kind", "name", "at");
CREATE INDEX "TelemetryEvent_fingerprint_at_idx" ON "TelemetryEvent"("fingerprint", "at");
