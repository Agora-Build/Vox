-- Turn Success Rate (0..1): opportunity-weighted composite of the response,
-- interrupt, and false-barge-in rates. Unlike latency, a no-response run counts
-- as a failed turn here, so TSR stays meaningful under network impairment and
-- serves as the quality/resilience axis on realtime + leaderboard.
ALTER TABLE eval_results ADD COLUMN turn_success_rate real;
