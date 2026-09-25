-- Unified steps model (designs/2026-09-25-unified-workflow-steps-design.md §4):
-- phone specifics dissolve into the shared Setup/Teardown step scripts; the
-- per-mode config keys phoneDial/restfulTrigger are deleted (clean cut).
--
-- EXACT-parity conversion of phoneDial evalflows (prod: evalflow 18) to the
-- step form the deleted daemon auto-wrap used to inject:
--   Setup    = call.dial <number> → call.wait_answered
--   Teardown = call.hangup
-- Guarded: PHONE transport only, a usable number, and no pre-existing step
-- scripts (nothing to silently overwrite — no such row exists, but the API
-- accepted the combination, so the guard is cheap insurance).
UPDATE evalflows
SET config = (config - 'phoneDial') || jsonb_build_object(
  'stepsPrefix',
  E'- type: call.dial\n  number: "' || (config->'phoneDial'->>'number') || E'"\n- type: call.wait_answered\n',
  'stepsSuffix',
  E'- type: call.hangup\n')
WHERE config ? 'phoneDial'
  AND transport = 'phone'
  AND config->'phoneDial'->>'number' IS NOT NULL
  AND NOT (config ? 'stepsPrefix')
  AND NOT (config ? 'stepsSuffix');
--> statement-breakpoint
-- Residual sweep: any phoneDial row the conversion above did not match (web
-- transport, null number, or pre-existing steps — kept as authored) plus any
-- restfulTrigger row (none exists anywhere) just loses the dead keys, so the
-- new validator never blocks a future edit on a key nothing reads.
UPDATE evalflows
SET config = config - 'phoneDial' - 'restfulTrigger'
WHERE config ? 'phoneDial' OR config ? 'restfulTrigger';
