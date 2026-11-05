ALTER TABLE eval_jobs
  ADD COLUMN network_changed boolean NOT NULL DEFAULT false,
  ADD COLUMN network_monitoring varchar(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN network_change_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE eval_job_network_state (
  job_id integer PRIMARY KEY REFERENCES eval_jobs(id) ON DELETE CASCADE,
  agent_id integer NOT NULL,
  lease_id text,
  started_at timestamp NOT NULL,
  observed_ip text,
  link_type varchar(16),
  first_seq bigint,
  last_seq bigint,
  monitoring_gap boolean NOT NULL DEFAULT false,
  finalized boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE eval_job_network_events (
  id serial PRIMARY KEY,
  job_id integer NOT NULL REFERENCES eval_jobs(id) ON DELETE CASCADE,
  agent_id integer NOT NULL,
  lease_id text,
  started_at timestamp NOT NULL,
  seq bigint,
  event varchar(32) NOT NULL,
  source varchar(8) NOT NULL,
  occurred_at timestamp NOT NULL,
  offset_ms integer NOT NULL,
  tags jsonb NOT NULL,
  changed jsonb NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX eval_job_network_events_identity_idx
  ON eval_job_network_events(job_id, agent_id, lease_id, started_at, source, seq);
--> statement-breakpoint
CREATE INDEX eval_job_network_events_history_idx ON eval_job_network_events(job_id, started_at, id);
--> statement-breakpoint
CREATE INDEX eval_jobs_strict_network_idx ON eval_jobs(id)
  WHERE network_monitoring = 'complete' AND network_changed = false;
