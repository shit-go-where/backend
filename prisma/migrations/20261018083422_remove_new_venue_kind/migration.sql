-- AlterEnum
BEGIN;
CREATE TYPE "SubmissionKind_new" AS ENUM ('NEW_TOILET', 'EDIT_TOILET', 'CLOSE_TOILET');
ALTER TABLE "Submission" ALTER COLUMN "kind" TYPE "SubmissionKind_new" USING ("kind"::text::"SubmissionKind_new");
ALTER TYPE "SubmissionKind" RENAME TO "SubmissionKind_old";
ALTER TYPE "SubmissionKind_new" RENAME TO "SubmissionKind";
DROP TYPE "public"."SubmissionKind_old";
COMMIT;

