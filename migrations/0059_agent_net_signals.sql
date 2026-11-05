-- Agent network signals (designs/2026-10-22-network-tags-design.md "Where
-- it's computed and stored", Part-2 Task 3). Reported on register/heartbeat
-- as `netSignals: { cloudMetadata?, publicIpOnInterface? }`; stored here
-- (system-written only, via server/routes.ts' parsed+merged update) so the
-- periodic location recheck (every LOCATION_RECHECK_HOURS) sees the latest
-- reported value rather than whatever was true at the last recheck.
ALTER TABLE eval_agents ADD COLUMN net_signals jsonb;
