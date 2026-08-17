CREATE TABLE listings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id       bigint NOT NULL,
  price_per_unit bigint NOT NULL CHECK (price_per_unit > 0),
  owner_id       integer NOT NULL,
  region         text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_by     integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX listings_token_id_uq ON listings (token_id);
CREATE INDEX listings_active ON listings (id) WHERE active;
--> statement-breakpoint
CREATE TABLE settlements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         bigint,
  hold_id        bigint,
  payer_user_id  integer NOT NULL,
  earner_user_id integer NOT NULL,
  price_units    bigint NOT NULL,
  price_per_unit bigint NOT NULL,
  charge_credits bigint NOT NULL,
  fee_credits    bigint NOT NULL,
  artifact_valid boolean,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled','refunded')),
  void_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz
);
CREATE UNIQUE INDEX settlements_job_id_uq ON settlements (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX settlements_pending ON settlements (id) WHERE status = 'pending';
