CREATE TABLE grant_batches (
  id uuid PRIMARY KEY,
  admin_user_id integer NOT NULL,
  user_ids integer[] NOT NULL,
  credits bigint NOT NULL CHECK(credits>0),
  reason text NOT NULL,
  verification_receipt text NOT NULL,
  status text NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE TABLE grant_recipients (
  batch_id uuid NOT NULL REFERENCES grant_batches(id),
  user_id integer NOT NULL,
  group_id uuid,
  PRIMARY KEY(batch_id,user_id)
);
--> statement-breakpoint
CREATE TABLE welcome_backfill (
  id integer PRIMARY KEY CHECK(id=1),
  last_user_id integer NOT NULL DEFAULT 0
);
INSERT INTO welcome_backfill(id) VALUES(1);
