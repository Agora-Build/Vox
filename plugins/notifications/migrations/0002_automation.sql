ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check CHECK (status IN ('pending','sending','delivered','failed','expired'));
ALTER TABLE deliveries ADD COLUMN lease_token uuid;
ALTER TABLE deliveries ADD COLUMN lease_until timestamptz;
ALTER TABLE deliveries ADD COLUMN rule_id uuid;
ALTER TABLE deliveries ADD COLUMN subject_ref integer;
ALTER TABLE deliveries ADD COLUMN channel_id uuid;
--> statement-breakpoint
CREATE TABLE editor_permissions (
  user_ref integer PRIMARY KEY,
  can_edit boolean NOT NULL DEFAULT false,
  can_script boolean NOT NULL DEFAULT false,
  can_llm boolean NOT NULL DEFAULT false,
  group_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audience_groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  user_refs integer[] NOT NULL,
  created_by integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE channels (
  id uuid PRIMARY KEY,
  owner_ref integer NOT NULL,
  group_id uuid REFERENCES audience_groups(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email','discord')),
  destination_ciphertext text,
  enabled boolean NOT NULL DEFAULT true,
  revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rules (
  id uuid PRIMARY KEY,
  editor_ref integer NOT NULL,
  definition jsonb NOT NULL,
  revision uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rule_states (
  rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  subject_ref integer NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_matched boolean NOT NULL DEFAULT false,
  last_hash text,
  last_fired_at timestamptz,
  last_evaluated_at timestamptz,
  last_error text,
  PRIMARY KEY(rule_id,subject_ref)
);
CREATE INDEX rule_states_due_idx ON rule_states(due_at);
CREATE TABLE events (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL,
  rule_revision uuid NOT NULL,
  subject_ref integer NOT NULL,
  matched boolean NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_subject_idx ON events(subject_ref,created_at DESC);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_ref integer NOT NULL,
  action text NOT NULL,
  object_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llm_daily_budget (
  day date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0
);
