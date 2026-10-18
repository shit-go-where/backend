-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Feature" ADD VALUE 'SANITARY_BIN';
ALTER TYPE "Feature" ADD VALUE 'PERIOD_PRODUCTS';
ALTER TYPE "Feature" ADD VALUE 'MIRROR';
ALTER TYPE "Feature" ADD VALUE 'WATER_REFILL';
ALTER TYPE "Feature" ADD VALUE 'ABLUTION';
