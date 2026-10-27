-- Network tags part 2 (designs/2026-10-22-network-tags-design.md "Last mile
-- vs datacenter (`access`)" and "`sim` is system-only"). System-only columns:
-- written by Core's location check / SIM check, never by any route from a
-- request body.
-- access: lastmile | datacenter | unknown, with the versioned reason that
-- decided it (e.g. "v1: dc-range") and when it was last computed.
ALTER TABLE eval_agents ADD COLUMN access_class varchar(16);
ALTER TABLE eval_agents ADD COLUMN access_reason text;
ALTER TABLE eval_agents ADD COLUMN access_checked_at timestamp;
-- sim: the carrier slug of our SIM (phone agents), why (or why not), and our
-- own number redacted to its last 4 digits — the full number is never stored.
ALTER TABLE eval_agents ADD COLUMN sim_carrier varchar(48);
ALTER TABLE eval_agents ADD COLUMN sim_reason text;
ALTER TABLE eval_agents ADD COLUMN sim_number_redacted varchar(8);
-- MCC/MNC of a looked-up number (Twilio line_type_intelligence), matched
-- against the SIM operator's codes.
ALTER TABLE number_lookups ADD COLUMN mcc varchar(3);
ALTER TABLE number_lookups ADD COLUMN mnc varchar(3);
