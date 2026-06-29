-- How an eval job was triggered: 1 = scheduled, 2 = manual. Recorded at creation
-- so the origin survives schedule deletion (which sets schedule_id to NULL).
-- Nullable: rows created before this column fall back to schedule_id in the API.
ALTER TABLE eval_jobs ADD COLUMN trigger_type integer;
