-- #215: eval_agent_tokens.expires_at was half-built: nothing ever set it (it
-- is NULL on every row) and only registration read it. Agent tokens end by
-- revocation, which every agent path checks. Drop it rather than keep a check
-- that would behave inconsistently the day someone set it.
ALTER TABLE eval_agent_tokens DROP COLUMN expires_at;
