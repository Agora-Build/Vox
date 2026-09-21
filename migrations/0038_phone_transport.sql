-- Phone vs Agent Phase A (designs/2026-09-21-phone-vs-agent-design.md §3, §7, §8):
-- transport axis (web|phone) on workflows, frozen per-job for claim gating;
-- agent capability declaration; phone call metadata on results.
-- No backfill needed: every pre-existing row IS web — the default is the truth.
CREATE TYPE "transport" AS ENUM ('web', 'phone');
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "transport" "transport" DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "transport" "transport" DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "call_metadata" jsonb;
