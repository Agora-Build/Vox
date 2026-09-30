-- How many times the no-agent reaper requeued a pending job because no agent
-- served its site (#82). Kept apart from retry_count, which is the budget for
-- recovering a job whose agent died mid-run: waiting for an agent is not a
-- failed run, and must not leave the job without that protection once it is
-- finally claimed. Existing rows start at 0.
ALTER TABLE eval_jobs ADD COLUMN unclaimed_count integer DEFAULT 0 NOT NULL;
