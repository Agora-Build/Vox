-- Latency columns become nullable so "agent did not respond" can be stored as
-- NA (NULL) instead of 0. A 0 ms latency for a non-responsive agent would rank
-- it as the fastest in the fleet and drag every average toward zero; NULL keeps
-- it out of latency aggregates while response_rate (0) carries the real signal.
ALTER TABLE eval_results ALTER COLUMN response_latency_median DROP NOT NULL;
ALTER TABLE eval_results ALTER COLUMN response_latency_sd DROP NOT NULL;
ALTER TABLE eval_results ALTER COLUMN response_latency_p95 DROP NOT NULL;
ALTER TABLE eval_results ALTER COLUMN interrupt_latency_median DROP NOT NULL;
ALTER TABLE eval_results ALTER COLUMN interrupt_latency_sd DROP NOT NULL;
ALTER TABLE eval_results ALTER COLUMN interrupt_latency_p95 DROP NOT NULL;
