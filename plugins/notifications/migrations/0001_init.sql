CREATE TABLE deliveries (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  channel text NOT NULL DEFAULT 'email',
  payload_ciphertext text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','expired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  delivered_at timestamp
);
--> statement-breakpoint
CREATE INDEX deliveries_pending_idx ON deliveries(next_attempt_at) WHERE status='pending';
