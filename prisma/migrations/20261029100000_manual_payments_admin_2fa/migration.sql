-- Payment is manual only: drop the retired SANDBOX method (it only ever existed outside production,
-- so any such rows are test data from development databases).
DELETE FROM "Payment" WHERE "method" = 'SANDBOX';
BEGIN;
CREATE TYPE "PaymentMethod_new" AS ENUM ('BKASH', 'NAGAD', 'ROCKET');
ALTER TABLE "Payment" ALTER COLUMN "method" TYPE "PaymentMethod_new" USING ("method"::text::"PaymentMethod_new");
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
ALTER TYPE "PaymentMethod_new" RENAME TO "PaymentMethod";
DROP TYPE "public"."PaymentMethod_old";
COMMIT;

-- Admin two-factor authentication (TOTP) state.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT,
ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpLastStep" INTEGER,
ADD COLUMN "totpBackupHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
