-- Backfill for trust model v2 (PLAN.md §12 E1/E2). Separate from the schema migration because
-- Postgres cannot use enum values added in the same transaction.

-- Seen by: the submitter (community toilets) plus every other distinct person who checked in, min 1.
UPDATE "Toilet" t
SET "seenBy" = GREATEST(
  1,
  (CASE WHEN t."createdById" IS NOT NULL THEN 1 ELSE 0 END)
  + (SELECT COUNT(DISTINCT c."userId") FROM "CheckIn" c
     WHERE c."toiletId" = t.id AND c."userId" IS NOT NULL AND c."userId" IS DISTINCT FROM t."createdById")
);

-- What each existing submission would have been tagged with at creation.
UPDATE "Submission" s
SET "hasPhoto" = EXISTS (SELECT 1 FROM "Photo" p WHERE p."submissionId" = s.id AND p.confirmed);

UPDATE "Submission" s
SET "onSite" = TRUE
FROM "Toilet" t
WHERE s."toiletId" = t.id
  AND s."submittedLat" IS NOT NULL AND s."submittedLng" IS NOT NULL
  -- equirectangular approximation, plenty for 150 m
  AND sqrt(
    power(radians(t.latitude - s."submittedLat") * 6371008.8, 2)
    + power(radians(t.longitude - s."submittedLng") * cos(radians(t.latitude)) * 6371008.8, 2)
  ) <= 150;

-- Free-text resolutions become stable codes; moderator notes move to resolutionNote.
UPDATE "Submission" SET "resolutionNote" = "resolution"
WHERE "resolution" IS NOT NULL
  AND "resolution" NOT IN (
    'Approved by community vote', 'Rejected by moderator vote',
    'Two reviewers rejected it; more info needed', 'Expired without quorum',
    'APPROVED by moderator', 'REJECTED by moderator', 'NEEDS_INFO by moderator'
  );

UPDATE "Submission" SET "resolution" = CASE
  WHEN "resolution" = 'Approved by community vote' THEN 'community_approved'
  WHEN "resolution" = 'Rejected by moderator vote' THEN 'moderator_rejected'
  WHEN "resolution" = 'Two reviewers rejected it; more info needed' THEN 'peer_needs_info'
  WHEN "resolution" = 'Expired without quorum' THEN 'expired'
  WHEN "state" = 'APPROVED' THEN 'moderator_approved'
  WHEN "state" = 'REJECTED' THEN 'moderator_rejected'
  WHEN "state" = 'NEEDS_INFO' THEN 'moderator_needs_info'
  ELSE "resolution"
END
WHERE "resolution" IS NOT NULL;

-- Expiry used to reject the toilet; moderation is now the safety net, so escalate instead.
UPDATE "Toilet" t SET "status" = 'PENDING'
FROM "Submission" s
WHERE s."toiletId" = t.id AND s."kind" = 'NEW_TOILET' AND s."state" = 'EXPIRED' AND t."status" = 'REJECTED';

UPDATE "Submission"
SET "state" = 'ESCALATED', "escalatedAt" = COALESCE("resolvedAt", now()), "resolvedAt" = NULL,
    "resolution" = 'escalated_expired'
WHERE "state" = 'EXPIRED';
