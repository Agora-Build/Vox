-- Our SIM's number, as a keyed hash (HMAC-SHA256 with a server key —
-- server/number-lookup.ts numberHash), next to sim_number_redacted. Lets the
-- SIM check tell "the same number" from "another number with the same last
-- four digits" without storing the number. Core-internal; NULL on rows
-- written before it existed (treated as a different number).
ALTER TABLE eval_agents ADD COLUMN sim_number_hash varchar(64);
