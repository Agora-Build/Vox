-- #217: every eval result carried the eval agent's placeholder defaults for
-- three metrics nothing measures — network_resilience 85, naturalness 3.5,
-- noise_reduction 90 — shown as results and ranked on by the leaderboard.
-- Clear exactly that triple (a real measurement matching all three is not a
-- realistic case). Scans eval_results once at deploy.
UPDATE eval_results
SET network_resilience = NULL, naturalness = NULL, noise_reduction = NULL
WHERE network_resilience = 85 AND naturalness = 3.5 AND noise_reduction = 90;
