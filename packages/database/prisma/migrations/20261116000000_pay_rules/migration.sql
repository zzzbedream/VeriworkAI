-- Pay rules, part 1: per-campaign QA profile, attempts per item, the stored reviewer verdict and
-- VOIDED submissions (closed without a verdict, unpaid). Safe on a database that already holds rows:
-- every new column is nullable or has a default, and existing reviews are backfilled here. Rows that
-- need the new VOIDED value, the attempt numbers and every constraint follow in the next migration,
-- because a new enum value can only be used once the migration that added it has committed.

-- CreateEnum
CREATE TYPE "SubmissionVoidReason" AS ENUM ('BATCH_FROZEN', 'BATCH_CANCELLED', 'CONFLICT_OF_INTEREST', 'LEGACY_RULES');

-- AlterEnum
ALTER TYPE "SubmissionStatus" ADD VALUE 'VOIDED';

-- AlterTable: every existing campaign was decided 2 of 3, the Standard profile (the defaults).
ALTER TABLE "Campaign" ADD COLUMN     "qaApprovalsRequired" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "qaQuorum" INTEGER NOT NULL DEFAULT 3;

-- AlterTable: "attempt" is numbered, made NOT NULL and unique per item by the next migration.
ALTER TABLE "TaskSubmission" ADD COLUMN     "attempt" INTEGER,
ADD COLUMN     "reviewerApprove" BOOLEAN,
ADD COLUMN     "voidReason" "SubmissionVoidReason";

-- Backfill: the verdict of every existing review (a score of 3 or more accepts).
UPDATE "TaskSubmission" SET "reviewerApprove" = ("reviewerScore" >= 3) WHERE "reviewerScore" IS NOT NULL;
