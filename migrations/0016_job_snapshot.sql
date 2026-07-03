-- Immutable per-job snapshot of workflow + eval-set (+ provider + creator plan),
-- plus the agent-token visibility captured at claim. Everything downstream reads
-- these instead of the live rows, so edits/deletes never rewrite a job's history.
ALTER TABLE "eval_jobs" ADD COLUMN "snapshot" jsonb;
ALTER TABLE "eval_jobs" ADD COLUMN "token_visibility" text;

-- Jobs (and their cascaded results) survive deletion of their workflow/eval-set.
ALTER TABLE "eval_jobs" ALTER COLUMN "workflow_id" DROP NOT NULL;
ALTER TABLE "eval_jobs" ALTER COLUMN "eval_set_id" DROP NOT NULL;

ALTER TABLE "eval_jobs" DROP CONSTRAINT "eval_jobs_workflow_id_workflows_id_fk";
ALTER TABLE "eval_jobs" ADD CONSTRAINT "eval_jobs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "eval_jobs" DROP CONSTRAINT "eval_jobs_eval_set_id_eval_sets_id_fk";
ALTER TABLE "eval_jobs" ADD CONSTRAINT "eval_jobs_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE set null ON UPDATE no action;

-- Backfill the snapshot for existing jobs from the current live rows (best-effort;
-- the only history available). Workflow/eval-set always exist here (their FKs were
-- NOT NULL until now); provider/creator may be null and degrade gracefully.
UPDATE eval_jobs j SET snapshot = jsonb_build_object(
  'provider', (SELECT CASE WHEN p.id IS NULL THEN NULL
                           ELSE jsonb_build_object('id', p.id, 'name', p.name, 'platformId', p.platform_id) END
               FROM workflows w LEFT JOIN providers p ON p.id = w.provider_id WHERE w.id = j.workflow_id),
  'workflow', (SELECT jsonb_build_object('name', w.name, 'config', w.config,
                        'visibility', w.visibility::text, 'isMainline', w.is_mainline, 'ownerId', w.owner_id)
               FROM workflows w WHERE w.id = j.workflow_id),
  'evalSet', (SELECT jsonb_build_object('name', e.name, 'config', e.config,
                        'visibility', e.visibility::text, 'isMainline', e.is_mainline, 'ownerId', e.owner_id)
              FROM eval_sets e WHERE e.id = j.eval_set_id),
  'creatorPlan', (SELECT u.plan::text FROM users u WHERE u.id = j.created_by)
)
WHERE j.snapshot IS NULL;

-- Backfill token visibility from the job's agent's token (claimed/completed jobs).
UPDATE eval_jobs j SET token_visibility = (
  SELECT t.visibility::text
  FROM eval_agents a JOIN eval_agent_tokens t ON t.id = a.token_id
  WHERE a.id = j.eval_agent_id
)
WHERE j.token_visibility IS NULL AND j.eval_agent_id IS NOT NULL;
