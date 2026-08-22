-- Rename the overloaded `region` column (which stores a full sequenced site id
-- like na-us-seattle-02, not a region) to `site_id` across all nine tables that
-- carry it, and rename the two region-bearing indexes to match. RENAME COLUMN is
-- metadata-only and preserves all data — no backfill.
ALTER TABLE "eval_agent_tokens" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_agents" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_schedules" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_jobs" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_results" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_events" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_runner_issued_tokens" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_runner_pool" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_schedules" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER INDEX "eval_jobs_status_region_idx" RENAME TO "eval_jobs_status_site_idx";
--> statement-breakpoint
ALTER INDEX "eval_results_provider_region_idx" RENAME TO "eval_results_provider_site_idx";
