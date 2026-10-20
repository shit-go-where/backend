-- Level-aware toilets: a sort key next to the free-text level (src/common/level.ts).
-- The values are filled by `pnpm cli levels:backfill`, which also rewrites `level` to its normalised
-- form; the normalisation rules live in TypeScript, so they are not repeated here in SQL.

-- The new (venueId, levelOrder) index serves every venueId lookup the old one did.
-- DropIndex
DROP INDEX "Toilet_venueId_idx";

-- AlterTable
ALTER TABLE "Toilet" ADD COLUMN     "levelOrder" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Toilet_venueId_levelOrder_idx" ON "Toilet"("venueId", "levelOrder");
