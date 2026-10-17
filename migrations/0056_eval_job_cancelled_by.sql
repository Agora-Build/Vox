-- Who cancelled a pending job, and when. The status stays 'failed' (reapers,
-- metrics and settlement are unchanged); the console shows it as Cancelled.
ALTER TABLE eval_jobs ADD COLUMN cancelled_by integer;
ALTER TABLE eval_jobs ADD COLUMN cancelled_at timestamp;
