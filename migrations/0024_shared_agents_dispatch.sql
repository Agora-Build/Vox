-- Dispatch tier for eval-agent tokens: private/team/public/shared, defaulting
-- existing + new tokens to "public" (today's de facto behavior). Paired with
-- eval_jobs.target_token_id so a job can optionally target a specific token's
-- agent pool. Schema foundation for the shared-agents dispatch model.
CREATE TYPE "public"."dispatch_tier" AS ENUM('private', 'team', 'public', 'shared');
ALTER TABLE "eval_agent_tokens" ADD COLUMN "dispatch_tier" "dispatch_tier" DEFAULT 'public' NOT NULL;

ALTER TABLE "eval_jobs" ADD COLUMN "target_token_id" integer;
ALTER TABLE "eval_jobs" ADD CONSTRAINT "eval_jobs_target_token_id_eval_agent_tokens_id_fk" FOREIGN KEY ("target_token_id") REFERENCES "public"."eval_agent_tokens"("id") ON DELETE set null ON UPDATE no action;
