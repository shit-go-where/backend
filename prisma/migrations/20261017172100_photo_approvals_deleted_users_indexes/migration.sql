-- DropIndex
DROP INDEX "PointsLedger_createdAt_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PhotoApproval" (
    "photoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoApproval_pkey" PRIMARY KEY ("photoId","userId")
);

-- CreateIndex
CREATE INDEX "PointsLedger_createdAt_userId_idx" ON "PointsLedger"("createdAt", "userId");

-- CreateIndex
CREATE INDEX "StatusReport_toiletId_userId_kind_createdAt_idx" ON "StatusReport"("toiletId", "userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Venue_planningArea_idx" ON "Venue"("planningArea");

-- AddForeignKey
ALTER TABLE "PhotoApproval" ADD CONSTRAINT "PhotoApproval_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoApproval" ADD CONSTRAINT "PhotoApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
