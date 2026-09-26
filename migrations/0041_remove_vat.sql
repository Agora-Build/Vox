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
    AND coalesce(btrim(config->>'stepsPrefix'), '') = ''
    AND coalesce(btrim(config->>'stepsSuffix'), '') = ''
);
--> statement-breakpoint
UPDATE evalflows
SET config = ((config - 'app') || jsonb_build_object('framework', 'aeval'))
  || CASE WHEN config ? 'app'
       THEN jsonb_build_object('_legacyVatApp', config->'app')
       ELSE '{}'::jsonb END
WHERE config->>'framework' = 'voice-agent-tester' OR config ? 'app';
--> statement-breakpoint
-- Jobs froze their merged config BEFORE mergeEvalConfig learned to strip
-- parked keys, so a row can carry _legacyPhoneDial (0040): an owner's phone
-- number travelling to whichever agent claims it, and readable by whoever RAN
-- the evalflow (anyone may run a public one). Stripped from EVERY job, not
-- just queued ones — these keys are dead data parked by 0040 itself, never
-- provenance content, so removing them doesn't rewrite history. The read
-- boundary redacts them for non-owners regardless; this removes the copy.
UPDATE eval_jobs
SET config = config - '_legacyPhoneDial' - '_legacyVatApp',
    snapshot = CASE
      WHEN snapshot #> '{evalflow,config}' IS NOT NULL
        THEN jsonb_set(snapshot, '{evalflow,config}',
               (snapshot #> '{evalflow,config}') - '_legacyPhoneDial' - '_legacyVatApp')
      ELSE snapshot END
WHERE config ? '_legacyPhoneDial' OR config ? '_legacyVatApp'
   OR snapshot #> '{evalflow,config}' ? '_legacyPhoneDial'
   OR snapshot #> '{evalflow,config}' ? '_legacyVatApp';
--> statement-breakpoint
-- A queued job froze `framework: voice-agent-tester` in its own config, so
-- the upgraded daemon would claim it and fail with "Unsupported eval
-- framework" — after an escrow hold/refund round-trip and an occupied agent
-- slot. Fail them here instead, with the reason recorded.
UPDATE eval_jobs
SET status = 'failed',
    error = 'voice-agent-tester was removed; re-run this eval after re-authoring the evalflow for aeval',
    completed_at = NOW()
WHERE status IN ('pending', 'running')
  AND config->>'framework' = 'voice-agent-tester';
