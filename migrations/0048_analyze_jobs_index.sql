-- #219: the Analyze list and the daily upload cap read a user's analyses by
-- creator and time; eval_jobs is shared with every eval run, so give that
-- lookup its own small partial index.
CREATE INDEX eval_jobs_analyze_creator_idx ON eval_jobs (created_by, created_at DESC) WHERE kind = 'analyze';
