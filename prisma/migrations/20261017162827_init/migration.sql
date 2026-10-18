-- CreateEnum
CREATE TYPE "VenueType" AS ENUM ('MRT_STATION', 'BUS_INTERCHANGE', 'MALL', 'HAWKER_CENTRE', 'COFFEESHOP', 'COMMUNITY_CLUB', 'PARK', 'LIBRARY', 'HOSPITAL', 'SPORTS_CENTRE', 'OTHER');

-- CreateEnum
CREATE TYPE "VenueToiletStatus" AS ENUM ('HAS_TOILETS', 'NONE', 'UNKNOWN', 'USES_NEARBY');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('FIELDWORK_2024', 'OSM', 'ONEMAP', 'DATAGOV', 'WIKIDATA', 'COMMUNITY', 'ADMIN');

-- CreateEnum
CREATE TYPE "ToiletTier" AS ENUM ('VERIFIED', 'COMMUNITY', 'IMPORTED');

-- CreateEnum
CREATE TYPE "ToiletStatus" AS ENUM ('ACTIVE', 'CLOSED', 'RENOVATION', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "AreaType" AS ENUM ('PAID_AREA', 'UNPAID_AREA', 'NOT_APPLICABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Feature" AS ENUM ('TOILET_PAPER', 'HAND_TOWEL', 'HAND_DRYER', 'HAND_SOAP', 'SEAT_LINER', 'BIDET', 'AUTO_FLUSH', 'AUTO_TAP', 'AUTO_SOAP', 'COAT_HOOK', 'FEEDBACK_DEVICE', 'SIGNAGE', 'POSTERS', 'AMBULANT', 'ACCESSIBLE', 'CHILD', 'BABY_CHANGE', 'NURSING_ROOM', 'SHOWER', 'SITTING', 'SQUAT', 'MALE', 'FEMALE', 'UNISEX', 'FREE');

-- CreateEnum
CREATE TYPE "SubmissionKind" AS ENUM ('NEW_TOILET', 'EDIT_TOILET', 'CLOSE_TOILET', 'NEW_VENUE');

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "StatusKind" AS ENUM ('ALL_GOOD', 'NO_PAPER', 'NO_SOAP', 'LONG_QUEUE', 'BEING_CLEANED', 'BROKEN', 'CLOSED_NOW');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'TRUSTED', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "PointReason" AS ENUM ('SUBMISSION_APPROVED', 'REVIEW_POSTED', 'REVIEW_WITH_PHOTO', 'STATUS_CONFIRMED', 'CHECK_IN', 'FIRST_CHECK_IN_AT_TOILET', 'VOTE_MATCHED_OUTCOME', 'SURVEY_COMPLETED');

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "VenueType" NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "postalCode" TEXT,
    "planningArea" TEXT,
    "lines" TEXT[],
    "toiletStatus" "VenueToiletStatus" NOT NULL DEFAULT 'UNKNOWN',
    "note" TEXT,
    "openingHours" JSONB,
    "source" "DataSource" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "externalIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Toilet" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "label" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "level" TEXT,
    "areaType" "AreaType" NOT NULL DEFAULT 'UNKNOWN',
    "nearestExit" TEXT,
    "accessNote" TEXT,
    "openingHours" JSONB,
    "tier" "ToiletTier" NOT NULL,
    "status" "ToiletStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "DataSource" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "needsResurvey" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "scoreCleanliness" DOUBLE PRECISION,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Toilet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToiletFeature" (
    "toiletId" TEXT NOT NULL,
    "feature" "Feature" NOT NULL,
    "present" BOOLEAN NOT NULL,
    "source" "DataSource" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToiletFeature_pkey" PRIMARY KEY ("toiletId","feature")
);

-- CreateTable
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "toiletId" TEXT NOT NULL,
    "surveyedAt" TIMESTAMP(3) NOT NULL,
    "surveyedById" TEXT,
    "phase" TEXT,
    "cleanliness" INTEGER NOT NULL,
    "scent" INTEGER NOT NULL,
    "aesthetics" INTEGER NOT NULL,
    "music" INTEGER NOT NULL,
    "toiletries" INTEGER NOT NULL,
    "facilities" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "rasStars" INTEGER,
    "remarks" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "googleSub" TEXT,
    "handle" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "trustScore" INTEGER NOT NULL DEFAULT 0,
    "leaderboardOptIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "kind" "SubmissionKind" NOT NULL,
    "state" "SubmissionState" NOT NULL DEFAULT 'PENDING',
    "toiletId" TEXT,
    "venueId" TEXT,
    "payload" JSONB NOT NULL,
    "submittedById" TEXT NOT NULL,
    "submittedLat" DOUBLE PRECISION,
    "submittedLng" DOUBLE PRECISION,
    "approvals" INTEGER NOT NULL DEFAULT 0,
    "rejections" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionVote" (
    "submissionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "comment" TEXT,
    "distanceM" INTEGER,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionVote_pkey" PRIMARY KEY ("submissionId","userId")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "toiletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cleanliness" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusReport" (
    "id" TEXT NOT NULL,
    "toiletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "StatusKind" NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatusReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusConfirmation" (
    "statusReportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusConfirmation_pkey" PRIMARY KEY ("statusReportId","userId")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbUrl" TEXT,
    "contentType" TEXT NOT NULL,
    "toiletId" TEXT,
    "submissionId" TEXT,
    "reviewId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvals" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "toiletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toiletId" TEXT NOT NULL,
    "distanceM" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "PointReason" NOT NULL,
    "refId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "rule" JSONB NOT NULL,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,
    "command" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "log" JSONB,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyValue" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyValue_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Venue_sourceKey_key" ON "Venue"("sourceKey");

-- CreateIndex
CREATE INDEX "Venue_latitude_longitude_idx" ON "Venue"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "Venue_type_idx" ON "Venue"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Toilet_sourceKey_key" ON "Toilet"("sourceKey");

-- CreateIndex
CREATE INDEX "Toilet_latitude_longitude_idx" ON "Toilet"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "Toilet_status_tier_idx" ON "Toilet"("status", "tier");

-- CreateIndex
CREATE INDEX "Toilet_venueId_idx" ON "Toilet"("venueId");

-- CreateIndex
CREATE INDEX "ToiletFeature_feature_present_idx" ON "ToiletFeature"("feature", "present");

-- CreateIndex
CREATE INDEX "Survey_toiletId_surveyedAt_idx" ON "Survey"("toiletId", "surveyedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- CreateIndex
CREATE INDEX "Submission_state_createdAt_idx" ON "Submission"("state", "createdAt");

-- CreateIndex
CREATE INDEX "Submission_submittedLat_submittedLng_idx" ON "Submission"("submittedLat", "submittedLng");

-- CreateIndex
CREATE INDEX "Review_toiletId_createdAt_idx" ON "Review"("toiletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_toiletId_userId_key" ON "Review"("toiletId", "userId");

-- CreateIndex
CREATE INDEX "StatusReport_toiletId_expiresAt_idx" ON "StatusReport"("toiletId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_key_key" ON "Photo"("key");

-- CreateIndex
CREATE INDEX "Photo_toiletId_approved_idx" ON "Photo"("toiletId", "approved");

-- CreateIndex
CREATE INDEX "Photo_approved_createdAt_idx" ON "Photo"("approved", "createdAt");

-- CreateIndex
CREATE INDEX "Flag_resolved_createdAt_idx" ON "Flag"("resolved", "createdAt");

-- CreateIndex
CREATE INDEX "CheckIn_userId_createdAt_idx" ON "CheckIn"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckIn_toiletId_createdAt_idx" ON "CheckIn"("toiletId", "createdAt");

-- CreateIndex
CREATE INDEX "PointsLedger_userId_idx" ON "PointsLedger"("userId");

-- CreateIndex
CREATE INDEX "PointsLedger_createdAt_idx" ON "PointsLedger"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointsLedger_userId_reason_refId_key" ON "PointsLedger"("userId", "reason", "refId");

-- AddForeignKey
ALTER TABLE "Toilet" ADD CONSTRAINT "Toilet_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Toilet" ADD CONSTRAINT "Toilet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToiletFeature" ADD CONSTRAINT "ToiletFeature_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_surveyedById_fkey" FOREIGN KEY ("surveyedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVote" ADD CONSTRAINT "SubmissionVote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVote" ADD CONSTRAINT "SubmissionVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReport" ADD CONSTRAINT "StatusReport_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReport" ADD CONSTRAINT "StatusReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusConfirmation" ADD CONSTRAINT "StatusConfirmation_statusReportId_fkey" FOREIGN KEY ("statusReportId") REFERENCES "StatusReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusConfirmation" ADD CONSTRAINT "StatusConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_toiletId_fkey" FOREIGN KEY ("toiletId") REFERENCES "Toilet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsLedger" ADD CONSTRAINT "PointsLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
