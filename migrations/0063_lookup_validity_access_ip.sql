-- Cache provider-reported invalid numbers without confusing them with valid
-- numbers whose carrier is unknown. Existing cache entries are positive answers.
ALTER TABLE number_lookups ADD COLUMN invalid_number boolean NOT NULL DEFAULT false;

-- An access classification is only valid for the IP it checked. Old rows have
-- no binding and are rechecked on the next heartbeat; never guess their IP.
ALTER TABLE eval_agents ADD COLUMN access_ip text;
