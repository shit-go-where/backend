-- AlterTable
ALTER TABLE "Flag" ADD COLUMN "resolutionNote" TEXT;

-- CreateIndex
CREATE INDEX "Flag_userId_resolvedAt_idx" ON "Flag"("userId", "resolvedAt");
