-- Per-process lease so only the current daemon instance may act as an agent.
-- Set at registration and echoed by the daemon on heartbeat/claim/complete; a
-- superseded instance (restart or duplicate on the same token) is fenced.
-- Nullable: rows created before this column / by pre-lease daemons skip fencing.
ALTER TABLE eval_agents ADD COLUMN current_lease_id text;
