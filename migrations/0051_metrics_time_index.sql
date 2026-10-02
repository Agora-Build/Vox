-- Bound historical detail lookups and their density probes by the viewed dates.
CREATE INDEX IF NOT EXISTS eval_results_created_at_idx ON eval_results (created_at);
