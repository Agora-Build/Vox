-- voice-agent-tester removal (PR #177): aeval is the only eval framework.
-- Any surviving row still declaring the removed framework (prod has none;
-- other instances may) becomes an aeval evalflow so the save-time validator
-- never blocks a future edit and the daemon's fail-loud unsupported-framework
-- path stops firing. The VAT-only `app` payload is PRESERVED under an inert
-- key (same rule as 0040's _legacyPhoneDial: a one-way migration never
-- destroys the only copy of authored config). The parked payload lives until
-- the owner next rewrites the config (the UI rebuilds config on save, and the
-- API strips _legacy* keys from writes) — recover it before then via
-- GET /api/evalflows/:id or psql.
--
-- Schedules are disabled ONLY where the row cannot run meaningfully as aeval:
-- an ex-VAT evalflow has no Setup Steps, so its scheduled runs would proceed
-- on the eval-set scenario alone against a target nobody configured — quietly
-- burning credits and, on a public row, publishing metrics for nothing.
-- Failing visibly (owner re-enables after re-authoring) beats running quietly
-- wrong. A row that ALREADY has steps keeps its schedule: the old validator
-- accepted a stray `app` key on any evalflow, so such a row was running fine
-- on aeval and only loses a key nothing read.
UPDATE eval_schedules SET is_enabled = false
WHERE evalflow_id IN (
  SELECT id FROM evalflows
  WHERE (config->>'framework' = 'voice-agent-tester'
         OR (config ? 'app' AND config->>'framework' IS DISTINCT FROM 'aeval'))
    AND NOT (config ? 'stepsPrefix' OR config ? 'stepsSuffix')
);
--> statement-breakpoint
UPDATE evalflows
SET config = ((config - 'app') || jsonb_build_object('framework', 'aeval'))
  || CASE WHEN config ? 'app'
       THEN jsonb_build_object('_legacyVatApp', config->'app')
       ELSE '{}'::jsonb END
WHERE config->>'framework' = 'voice-agent-tester' OR config ? 'app';
--> statement-breakpoint
-- Non-terminal jobs froze their merged config BEFORE mergeEvalConfig learned
-- to strip parked keys, so a pending row can still carry _legacyPhoneDial
-- (0040) — an owner's phone number that would travel to whichever agent
-- claims it, for a key nothing reads. Strip them; terminal rows are history
-- and stay untouched.
UPDATE eval_jobs
SET config = config - '_legacyPhoneDial' - '_legacyVatApp'
WHERE status IN ('pending', 'running')
  AND (config ? '_legacyPhoneDial' OR config ? '_legacyVatApp');
