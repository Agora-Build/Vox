-- Each OAuth state value, recorded when a callback claims it. The PRIMARY KEY
-- makes the claim atomic: of two callbacks carrying the same state — even ones
-- that loaded the session at the same moment — exactly one insert succeeds.
-- The session copy alone could not guarantee single use (#210 review: 200 of
-- 200 concurrent pairs both passed). Rows older than a day are pruned on claim.
CREATE TABLE used_states (
  value   text        PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX used_states_used_at_idx ON used_states (used_at);
