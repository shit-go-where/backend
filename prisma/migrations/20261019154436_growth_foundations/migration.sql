-- AlterTable
ALTER TABLE "Toilet" ADD COLUMN     "lastVerifiedById" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verifierCredit" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ToiletRouteDaily" (
    "toiletId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ToiletRouteDaily_pkey" PRIMARY KEY ("toiletId","day")
);

-- CreateTable
CREATE TABLE "MetricsDaily" (
    "day" DATE NOT NULL,
    "wac" INTEGER NOT NULL,
    "contributors" INTEGER NOT NULL,
    "checkIns" INTEGER NOT NULL,
    "statusReports" INTEGER NOT NULL,
    "reviews" INTEGER NOT NULL,
    "submissions" INTEGER NOT NULL,
    "votes" INTEGER NOT NULL,
    "freshPct" DOUBLE PRECISION NOT NULL,
    "toiletsByTier" JSONB NOT NULL,
    "pendingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricsDaily_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "ToiletRouteDaily_day_idx" ON "ToiletRouteDaily"("day");

-- AddForeignKey
ALTER TABLE "Toilet" ADD CONSTRAINT "Toilet_lastVerifiedById_fkey" FOREIGN KEY ("lastVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToiletRouteDaily" ADD CONSTRAINT "ToiletRouteDaily_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
