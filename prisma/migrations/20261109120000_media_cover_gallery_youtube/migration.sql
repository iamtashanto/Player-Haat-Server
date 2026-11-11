
-- CreateEnum
CREATE TYPE "VideoSource" AS ENUM ('YOUTUBE', 'UPLOAD');

-- AlterTable
ALTER TABLE "PlayerMedia" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "source" "VideoSource",
ADD COLUMN     "sportId" INTEGER,
ADD COLUMN     "videoId" TEXT;

-- AlterTable
ALTER TABLE "PlayerProfile" ADD COLUMN     "coverPublicId" TEXT,
ADD COLUMN     "coverUrl" TEXT;

-- CreateIndex
CREATE INDEX "PlayerMedia_profileId_type_sportId_idx" ON "PlayerMedia"("profileId", "type", "sportId");


-- Existing video links become YouTube ids on the player's first sports profile. Links that are not
-- YouTube (Facebook, Vimeo, junk) or belong to a player with no sport are dropped; the counts are
-- reported in the migration output.
DO $$
DECLARE
  r record;
  vid text;
  sid int;
  migrated int := 0;
  dropped int := 0;
BEGIN
  FOR r IN SELECT id, url, "profileId" FROM "PlayerMedia" WHERE type = 'VIDEO_LINK' AND source IS NULL LOOP
    vid := COALESCE(
      (regexp_match(r.url, '^https?://(?:www\.|m\.|music\.)?youtube\.com/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})'))[1],
      (regexp_match(r.url, '^https?://youtu\.be/([A-Za-z0-9_-]{11})'))[1],
      (regexp_match(r.url, '^https?://(?:www\.|m\.)?youtube(?:-nocookie)?\.com/(?:shorts|embed|live|v)/([A-Za-z0-9_-]{11})'))[1]
    );
    SELECT "sportId" INTO sid FROM "PlayerSport" WHERE "profileId" = r."profileId" ORDER BY "createdAt" LIMIT 1;
    IF vid IS NULL OR sid IS NULL THEN
      DELETE FROM "PlayerMedia" WHERE id = r.id;
      dropped := dropped + 1;
    ELSE
      UPDATE "PlayerMedia" SET source = 'YOUTUBE', "videoId" = vid, "sportId" = sid, url = 'https://www.youtube.com/watch?v=' || vid WHERE id = r.id;
      migrated := migrated + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'video links migrated to YouTube ids: %, dropped (not YouTube or no sport): %', migrated, dropped;
END $$;
