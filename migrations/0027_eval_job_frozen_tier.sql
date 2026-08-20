-- Replace the frozen agent visibility on jobs with a frozen agent dispatch tier.
-- Historical jobs only ever froze 'public'/'private' visibility (team/shared are
-- newer token tiers that were never written into token_visibility), so the map is
-- total: 'public' → 'public', everything else → 'private'. Never-claimed jobs have
-- token_visibility IS NULL and are not 'completed', so they never reach tiering;
-- left NULL they get stamped at claim.
ALTER TABLE "eval_jobs" ADD COLUMN "token_dispatch_tier" text;
--> statement-breakpoint
UPDATE "eval_jobs"
   SET "token_dispatch_tier" = CASE WHEN "token_visibility" = 'public' THEN 'public' ELSE 'private' END
 WHERE "token_visibility" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_jobs" DROP COLUMN "token_visibility";
