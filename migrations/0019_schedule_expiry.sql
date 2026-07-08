-- Schedule 90-day expiration lifecycle.
-- Add expires_at; existing schedules get a 90-day window from creation so
-- long-stale ones become inactive immediately (owners Extend the ones they keep).
ALTER TABLE eval_schedules ADD COLUMN expires_at timestamp;
UPDATE eval_schedules SET expires_at = created_at + interval '90 days' WHERE expires_at IS NULL;
