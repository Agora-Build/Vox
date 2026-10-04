CREATE TABLE user_verification_factors (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_step bigint NOT NULL DEFAULT -1,
  recovery_hashes jsonb NOT NULL DEFAULT '[]',
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE verification_challenges (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  action text NOT NULL,
  payload_hash text NOT NULL,
  method text NOT NULL CHECK (method IN ('totp', 'email')),
  code_hash text,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX verification_challenges_user_created_idx ON verification_challenges(user_id, created_at);
--> statement-breakpoint
CREATE TABLE security_audit (
  id text PRIMARY KEY,
  user_id integer NOT NULL,
  action text NOT NULL,
  payload_hash text NOT NULL,
  method text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE personal_entitlements (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  expires_at timestamp,
  PRIMARY KEY (user_id, source_ref)
);
