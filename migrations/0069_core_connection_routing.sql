CREATE TABLE core_connection_owners (
  kind text NOT NULL CHECK (kind IN ('agent', 'broker')),
  resource_id integer NOT NULL,
  core_id uuid NOT NULL,
  origin text,
  generation uuid NOT NULL,
  lease_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, resource_id)
);
CREATE INDEX core_connection_owners_expiry_idx ON core_connection_owners (expires_at);

CREATE TABLE core_routing_nonces (
  nonce uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX core_routing_nonces_expiry_idx ON core_routing_nonces (expires_at);

CREATE TABLE browser_viewer_grants (
  id uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id integer NOT NULL REFERENCES eval_jobs(id) ON DELETE CASCADE,
  target_key text NOT NULL UNIQUE,
  target jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX browser_viewer_grants_expiry_idx ON browser_viewer_grants (expires_at);
