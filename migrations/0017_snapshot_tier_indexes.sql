-- Expression indexes for the snapshot-based metric tier predicates. Tiering moved
-- from live workflows/eval_sets/users joins (which had B-tree indexes) to reading
-- eval_jobs.snapshot + token_visibility, so the mainline/community/my-evals filters
-- lost index coverage. These restore it for the eval_jobs-driven plans (e.g. the
-- all-time leaderboard/community queries).
CREATE INDEX eval_jobs_snap_wf_visibility_idx ON eval_jobs ((snapshot->'workflow'->>'visibility'));
CREATE INDEX eval_jobs_snap_wf_mainline_idx ON eval_jobs ((snapshot->'workflow'->>'isMainline'));
CREATE INDEX eval_jobs_snap_es_visibility_idx ON eval_jobs ((snapshot->'evalSet'->>'visibility'));
CREATE INDEX eval_jobs_snap_es_mainline_idx ON eval_jobs ((snapshot->'evalSet'->>'isMainline'));
CREATE INDEX eval_jobs_snap_creator_plan_idx ON eval_jobs ((snapshot->>'creatorPlan'));
CREATE INDEX eval_jobs_token_visibility_idx ON eval_jobs (token_visibility);
