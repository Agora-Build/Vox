-- Each token's latest agent row, for the pending job page's "why it's
-- waiting" (storage.getLatestAgentPerLiveToken: DISTINCT ON (token_id) ...
-- ORDER BY token_id, created_at DESC), which otherwise sorts the whole table
-- on every refresh. eval_agents is small, and migrations run before the app
-- starts, so a plain (transactional) build is fine.
CREATE INDEX eval_agents_token_created_idx ON eval_agents (token_id, created_at DESC);
