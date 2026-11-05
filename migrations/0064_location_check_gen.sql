-- Fence older asynchronous checks even when only the network signals changed.
ALTER TABLE eval_agents
  ADD COLUMN IF NOT EXISTS location_check_gen bigint NOT NULL DEFAULT 0;
