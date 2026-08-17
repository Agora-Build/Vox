-- Partial index for the shared-dispatch reap-settle sweep
-- (storage.getReapableSharedJobs): recently-terminal targeted jobs, newest first.
-- The sweep filters status IN ('completed','failed') AND target_token_id IS NOT NULL
-- AND completed_at >= cutoff AND snapshot->'settlementContext' IS NOT NULL, ordered
-- by completed_at DESC. Partial on the two scalar predicates keeps the index tiny —
-- only paid targeted dispatches (a rare slice of eval_jobs) qualify — while covering
-- the completed_at ordering. The jsonb settlementContext check is applied on the
-- small candidate set (review M4).
CREATE INDEX eval_jobs_reapable_shared_idx ON eval_jobs (completed_at)
  WHERE target_token_id IS NOT NULL AND status IN ('completed', 'failed');
