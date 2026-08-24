-- Tier-targeting: region×tier pools (designs/2026-08-24-tier-targeting-design.md).
-- Tokens learn their region; jobs gain (target_region, target_tier) and a
-- nullable site_id (stamped at claim); schedules move from exact site to pool.
ALTER TABLE "eval_agent_tokens" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
UPDATE "eval_agent_tokens" SET "region" = regexp_replace("site_id", '-[0-9]+$', '');
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "region" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "eval_agent_tokens_region_idx" ON "eval_agent_tokens" ("region");
--> statement-breakpoint
ALTER TABLE "eval_jobs" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "target_region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "target_tier" dispatch_tier;
--> statement-breakpoint
CREATE INDEX "eval_jobs_pending_pool_idx" ON "eval_jobs" ("target_region", "target_tier") WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE "eval_schedules" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
UPDATE "eval_schedules" SET "region" = regexp_replace("site_id", '-[0-9]+$', '');
--> statement-breakpoint
ALTER TABLE "eval_schedules" ALTER COLUMN "region" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_schedules" ADD COLUMN "target_tier" dispatch_tier DEFAULT 'public' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_schedules" DROP COLUMN "site_id";
