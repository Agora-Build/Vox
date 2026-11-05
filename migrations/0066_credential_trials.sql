ALTER TABLE eval_flows
  ADD COLUMN trial_limit_24_hours integer NOT NULL DEFAULT 5 CHECK (trial_limit_24_hours BETWEEN 0 AND 10000),
  ADD COLUMN trial_limit_30_days integer NOT NULL DEFAULT 80 CHECK (trial_limit_30_days BETWEEN 0 AND 10000);

CREATE TABLE credential_trial_policies (
  scope_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  max_runs_30_days integer NOT NULL DEFAULT 0 CHECK (max_runs_30_days BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Usage survives job/account deletion: deleting history must never refund a trial.
CREATE TABLE credential_trial_usage (
  id serial PRIMARY KEY,
  scope_key text NOT NULL,
  caller_id integer NOT NULL,
  request_key text NOT NULL,
  eval_flow_id integer REFERENCES eval_flows(id) ON DELETE SET NULL,
  job_id integer UNIQUE REFERENCES eval_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_trial_usage_scope_time_idx ON credential_trial_usage(scope_key, created_at);
CREATE INDEX credential_trial_usage_caller_time_idx ON credential_trial_usage(eval_flow_id, caller_id, created_at);
CREATE UNIQUE INDEX credential_trial_usage_request_idx ON credential_trial_usage(caller_id, request_key);
