-- #129: whether Core can reach a broker's advertised URL. Heartbeats prove
-- broker→Core; mints need Core→broker, which nothing checked — a wrong
-- BROKER_ADVERTISE_URL looked healthy until the first mint failed.
-- reachability_error NULL with reachability_checked_at set = reachable.
ALTER TABLE brokers ADD COLUMN reachability_checked_at timestamp;
ALTER TABLE brokers ADD COLUMN reachability_error text;
