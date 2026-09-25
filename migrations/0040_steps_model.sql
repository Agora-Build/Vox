-- Unified steps model (designs/2026-09-25-unified-workflow-steps-design.md §4):
-- phone specifics dissolve into the shared Setup/Teardown step scripts; the
-- per-mode config keys phoneDial/restfulTrigger are deleted (clean cut).
--
-- EXACT-parity conversion of every phoneDial evalflow (prod: evalflow 18) to
-- the step form the deleted daemon auto-wrap used to inject:
--   Setup    = call.dial <number> → call.wait_answered
--   Teardown = call.hangup
-- Phone rows never had stepsPrefix/stepsSuffix (the old UI omitted them for
-- phone), so overwriting the keys is safe. Frozen eval_jobs snapshots are NOT
-- rewritten: they are history, and completed jobs never re-execute.
UPDATE evalflows
SET config = (config - 'phoneDial') || jsonb_build_object(
  'stepsPrefix',
  E'- type: call.dial\n  number: "' || (config->'phoneDial'->>'number') || E'"\n- type: call.wait_answered\n',
  'stepsSuffix',
  E'- type: call.hangup\n')
WHERE config ? 'phoneDial';
--> statement-breakpoint
-- restfulTrigger: no row anywhere carries it; hygiene sweep in case one does.
UPDATE evalflows
SET config = config - 'restfulTrigger'
WHERE config ? 'restfulTrigger';
