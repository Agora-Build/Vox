-- Durable spending caps on paid number lookups (server/paid-lookup-budget.ts).
-- One row per (scope, subject, UTC calendar day): scope is global | flow-user
-- | sim-agent | sim-user, subject is 'all' / a user id / an agent id. A slot
-- is reserved with one atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE
-- count < limit, so concurrent requests and several Core processes can't both
-- pass, and a restart doesn't reset the day.
CREATE TABLE paid_lookup_usage (
  scope varchar(16) NOT NULL,
  subject varchar(64) NOT NULL,
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject, day)
);

-- number_lookups no longer holds phone numbers in the clear: it is keyed by a
-- keyed hash of the E.164 number (HMAC-SHA256 with a server key,
-- server/number-lookup.ts numberHash). The table is a 30-day cache only, so
-- its rows (keyed by plaintext numbers) are dropped with it and refill on
-- the next lookup of each number. Recreated rather than altered so no
-- primary-key constraint name has to be assumed.
DROP TABLE number_lookups;
CREATE TABLE number_lookups (
  number_hash varchar(64) PRIMARY KEY,
  provider varchar(16) NOT NULL,
  carrier_name text,
  line_type varchar(32),
  value varchar(48),
  mcc varchar(3),
  mnc varchar(3),
  looked_up_at timestamp NOT NULL DEFAULT now()
);
