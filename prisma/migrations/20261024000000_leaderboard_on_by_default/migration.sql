-- The leaderboard is opt-out: everyone with a handle and points is listed unless they turn it off in Me.
-- Until now it was opt-in and nothing recorded who had chosen "off", so every live account starts on;
-- deleted accounts stay off (account deletion sets it to false).

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "leaderboardOptIn" SET DEFAULT true;

UPDATE "User" SET "leaderboardOptIn" = true WHERE "deletedAt" IS NULL AND "leaderboardOptIn" = false;
