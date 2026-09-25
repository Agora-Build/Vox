-- voice-agent-tester removal (PR #177): aeval is the only eval framework.
-- Any surviving row still declaring the removed framework (prod has none;
-- other instances may) becomes an aeval evalflow so the save-time validator
-- never blocks a future edit and the daemon's fail-loud unsupported-framework
-- path stops firing. NOTE: a converted row has no Setup Steps — its runs
-- proceed on the eval-set scenario alone and typically still need
-- re-authoring (platform.setup etc.) to be useful. The parked payload lives
-- until the owner next rewrites the config (the UI rebuilds config on save,
-- and the API strips _legacy* keys from writes) — recover it before then via
-- GET /api/evalflows/:id or psql. The VAT-only `app` payload is PRESERVED under
-- an inert key (same rule as 0040's _legacyPhoneDial: a one-way migration
-- never destroys the only copy of authored config).
-- Schedules on converted rows are DISABLED: an ex-VAT evalflow has no Setup
-- Steps, so its scheduled aeval runs would proceed on the eval-set scenario
-- against a target nobody configured — quietly burning credits and, on a
-- public row, publishing metrics for nothing. Failing visibly (owner
-- re-enables after re-authoring) beats running quietly wrong.
UPDATE eval_schedules SET is_enabled = false
WHERE evalflow_id IN (
  SELECT id FROM evalflows
  WHERE config->>'framework' = 'voice-agent-tester' OR config ? 'app'
);
--> statement-breakpoint
UPDATE evalflows
SET config = ((config - 'app') || jsonb_build_object('framework', 'aeval'))
  || CASE WHEN config ? 'app'
       THEN jsonb_build_object('_legacyVatApp', config->'app')
       ELSE '{}'::jsonb END
WHERE config->>'framework' = 'voice-agent-tester' OR config ? 'app';
