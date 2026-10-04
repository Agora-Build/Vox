ALTER TABLE deliveries
  ALTER COLUMN next_attempt_at TYPE timestamptz USING next_attempt_at AT TIME ZONE 'UTC',
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN delivered_at TYPE timestamptz USING delivered_at AT TIME ZONE 'UTC';
