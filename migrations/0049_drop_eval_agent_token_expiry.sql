-- #221 (follows #215): drop eval_agent_tokens.expires_at. It was never set and
-- nothing reads it since #220, which is live; dropping it in that same
-- release would have broken the old container during the deploy overlap,
-- since its queries still selected the column.
ALTER TABLE eval_agent_tokens DROP COLUMN expires_at;
