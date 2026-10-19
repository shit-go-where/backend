-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PointReason" ADD VALUE 'NEW_TOILET_SUBMITTED';
ALTER TYPE "PointReason" ADD VALUE 'NEW_TOILET_CONFIRMED';

-- AlterEnum
ALTER TYPE "SubmissionState" ADD VALUE 'ESCALATED';

-- DropForeignKey
ALTER TABLE "CheckIn" DROP CONSTRAINT "CheckIn_userId_fkey";

-- DropForeignKey
ALTER TABLE "StatusReport" DROP CONSTRAINT "StatusReport_userId_fkey";

-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN     "deviceId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StatusReport" ADD COLUMN     "deviceId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "autoPublished" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "hasPhoto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onSite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolutionNote" TEXT;

-- AlterTable
ALTER TABLE "SubmissionVote" ADD COLUMN     "checkInId" TEXT;

-- AlterTable
ALTER TABLE "Toilet" ADD COLUMN     "seenBy" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "handleChangedAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenActivityAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CheckIn_deviceId_createdAt_idx" ON "CheckIn"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "Flag_toiletId_resolved_idx" ON "Flag"("toiletId", "resolved");

-- CreateIndex
CREATE INDEX "StatusReport_deviceId_createdAt_idx" ON "StatusReport"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "Submission_submittedById_createdAt_idx" ON "Submission"("submittedById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVote_checkInId_key" ON "SubmissionVote"("checkInId");

-- AddForeignKey
ALTER TABLE "SubmissionVote" ADD CONSTRAINT "SubmissionVote_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReport" ADD CONSTRAINT "StatusReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

