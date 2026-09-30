-- The pending-job no-agent reaper asks, for each pending site-pinned job,
-- whether an agent serving that site was seen recently:
--   NOT EXISTS (SELECT 1 FROM eval_agents WHERE site_id = $site AND last_seen_at >= $cutoff)
-- eval_agents had no index on either column, so that was a scan per job — the
-- first thing to degrade as the agent table grows (#83).
CREATE INDEX eval_agents_site_last_seen_idx ON eval_agents (site_id, last_seen_at);
