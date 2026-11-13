ALTER TABLE web_sessions
  ADD COLUMN mint_broker_id integer,
  ADD COLUMN mint_operation_id text,
  ADD COLUMN mint_deadline_at timestamp;
