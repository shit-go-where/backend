-- Expanded 2024 survey contract (Phase 1): Survey becomes rubric-agnostic.
-- Every existing Survey row is the March 2024 pilot, so `rubric` is added with a PILOT_50 default,
-- backfilled, then the default is dropped (new rows must say which rubric they use).
-- `cleanliness` becomes Float (0-10 normalised for every rubric); pilot values are unchanged.
-- Pilot-only columns become nullable; the expanded rubric's native values go in `breakdown`.

-- CreateEnum
CREATE TYPE "SurveyRubric" AS ENUM ('PILOT_50', 'EXPANDED_2024');

-- CreateEnum
CREATE TYPE "SurveySex" AS ENUM ('MALE', 'FEMALE', 'UNISEX');

-- AlterEnum
ALTER TYPE "DataSource" ADD VALUE 'FIELDWORK_2024_EXPANDED';

-- AlterTable
ALTER TABLE "Survey" ADD COLUMN     "breakdown" JSONB,
ADD COLUMN     "rubric" "SurveyRubric" NOT NULL DEFAULT 'PILOT_50',
ADD COLUMN     "sex" "SurveySex",
ALTER COLUMN "cleanliness" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "scent" DROP NOT NULL,
ALTER COLUMN "aesthetics" DROP NOT NULL,
ALTER COLUMN "music" DROP NOT NULL,
ALTER COLUMN "toiletries" DROP NOT NULL,
ALTER COLUMN "facilities" DROP NOT NULL,
ALTER COLUMN "total" DROP NOT NULL;

-- Backfill (explicit, though the default already filled it), then drop the default.
UPDATE "Survey" SET "rubric" = 'PILOT_50';
ALTER TABLE "Survey" ALTER COLUMN "rubric" DROP DEFAULT;
