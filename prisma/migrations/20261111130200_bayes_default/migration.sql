-- New profiles start at the prior (platform mean fallback), so ordering never buries someone for having no reviews yet.
ALTER TABLE "PlayerProfile" ALTER COLUMN "bayesRating" SET DEFAULT 3.5;
UPDATE "PlayerProfile" SET "bayesRating" = ("ratingCount" * "avgRating" + 5 * 3.5) / ("ratingCount" + 5);
