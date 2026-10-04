CREATE TABLE webhook_lease (
  id smallint PRIMARY KEY CHECK (id=1),
  token uuid,
  expires_at timestamptz
);
INSERT INTO webhook_lease(id) VALUES(1);
