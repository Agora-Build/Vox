CREATE TABLE accounts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('user','system')),
  user_ref        integer,
  system_key      text,
  balance_credits bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_identity_ck CHECK (
    (kind = 'user'   AND user_ref IS NOT NULL AND system_key IS NULL) OR
    (kind = 'system' AND system_key IS NOT NULL AND user_ref IS NULL)
  ),
  CONSTRAINT accounts_user_nonneg_ck CHECK (kind = 'system' OR balance_credits >= 0)
);
CREATE UNIQUE INDEX accounts_user_ref_uq ON accounts (user_ref) WHERE user_ref IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_key_uq ON accounts (system_key) WHERE system_key IS NOT NULL;

CREATE TABLE ledger_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id),
  amount     bigint NOT NULL,
  reason     text NOT NULL,
  group_id   uuid NOT NULL,
  ref_type   text,
  ref_id     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_id_desc ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_group_id ON ledger_entries (group_id);

CREATE TABLE credit_holds (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payer_account_id bigint NOT NULL REFERENCES accounts(id),
  amount_credits   bigint NOT NULL CHECK (amount_credits > 0),
  status           text NOT NULL DEFAULT 'held' CHECK (status IN ('held','captured','released')),
  ref_type         text,
  ref_id           text,
  hold_group_id    uuid NOT NULL,
  settle_group_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz
);
CREATE INDEX credit_holds_held ON credit_holds (id) WHERE status = 'held';

CREATE TABLE idempotency_keys (
  key        text PRIMARY KEY,
  operation  text NOT NULL,
  group_id   uuid,
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO accounts (kind, system_key) VALUES
  ('system', 'external'),
  ('system', 'escrow'),
  ('system', 'platform');
