ALTER TABLE personal_entitlements ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE verification_challenges
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN consumed_at TYPE timestamptz USING consumed_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE user_verification_factors ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE security_audit ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
