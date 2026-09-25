-- voice-agent-tester removal (PR #177): aeval is the only eval framework.
-- Any surviving row still declaring the removed framework (prod has none;
-- other instances may) becomes an aeval evalflow so schedules/runs stop
-- producing jobs that only fail at the daemon, and the save-time validator
-- never blocks a future edit. The VAT-only `app` payload is PRESERVED under
-- an inert key (same rule as 0040's _legacyPhoneDial: a one-way migration
-- never destroys the only copy of authored config).
UPDATE evalflows
SET config = ((config - 'app') || jsonb_build_object('framework', 'aeval'))
  || CASE WHEN config ? 'app'
       THEN jsonb_build_object('_legacyVatApp', config->'app')
       ELSE '{}'::jsonb END
WHERE config->>'framework' = 'voice-agent-tester' OR config ? 'app';
