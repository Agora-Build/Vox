CREATE TABLE webhook_claims (
  customer_key text PRIMARY KEY,
  token uuid,
  expires_at timestamptz
);
