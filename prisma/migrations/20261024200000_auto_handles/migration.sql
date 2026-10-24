-- Every account gets a random pseudonymous handle (adjective_noun_NN) and so shows on the leaderboard
-- by default. "handleAuto" marks a handle the system picked; changing away from it is free.
-- Live accounts without a handle get one here, from the same word lists as src/users/handle-gen.ts.
-- Deleted accounts stay handle-less (and off the board).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "handleAuto" BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE
  adjs text[] := ARRAY[
    'shiok', 'steady', 'garang', 'kiasu', 'atas', 'swee', 'paiseh', 'chill',
    'solid', 'sporty', 'zippy', 'sunny', 'jolly', 'lucky', 'comfy', 'brave',
    'breezy', 'cheery', 'mellow', 'nifty', 'plucky', 'speedy', 'sleepy', 'cosy'];
  nouns text[] := ARRAY[
    'otter', 'pigeon', 'mynah', 'merlion', 'durian', 'kopi', 'teh', 'kaya',
    'prata', 'satay', 'laksa', 'rojak', 'chendol', 'kueh', 'otah', 'ondeh',
    'popiah', 'hornbill', 'pangolin', 'dugong', 'heron', 'bulbul', 'koel', 'macaque',
    'tembusu', 'rambutan', 'bandung', 'tauhu'];
  u record;
  cand text;
  tries int;
  low int;
BEGIN
  FOR u IN
    SELECT id FROM "User"
    WHERE handle IS NULL AND "deletedAt" IS NULL AND email NOT LIKE '%@deleted.invalid'
  LOOP
    tries := 0;
    LOOP
      -- 2 digits, then 3, then 4 when the pick keeps colliding.
      low := CASE WHEN tries < 4 THEN 10 WHEN tries < 7 THEN 100 ELSE 1000 END;
      cand := adjs[1 + floor(random() * array_length(adjs, 1))::int] || '_'
        || nouns[1 + floor(random() * array_length(nouns, 1))::int] || '_'
        || (low + floor(random() * 9 * low)::int)::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "User" WHERE handle = cand);
      tries := tries + 1;
    END LOOP;
    UPDATE "User" SET handle = cand, "handleAuto" = true WHERE id = u.id;
  END LOOP;
END $$;
