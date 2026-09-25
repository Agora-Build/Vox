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
  -- The save-time regex every phoneDial ever accepted — also guarantees the
  -- number is YAML-safe inside the double-quoted scalar above (no quotes,
  -- backslashes, or newlines can appear). A row failing it (never observed)
  -- falls through to the key-drop below rather than emitting broken YAML.
  AND config->'phoneDial'->>'number' ~ '^\+?[0-9 ()-]{5,20}$'
  -- Empty-string steps count as absent — nothing authored to preserve.
  AND coalesce(btrim(config->>'stepsPrefix'), '') = ''
  AND coalesce(btrim(config->>'stepsSuffix'), '') = '';
--> statement-breakpoint
-- Residual sweep: any phoneDial row the conversion above did not match (web
-- transport, malformed number, or pre-existing steps — kept as authored) plus
-- any restfulTrigger row (none exists anywhere) loses the dead keys, so the
-- new validator never blocks a future edit. The dial value is PRESERVED under
-- an inert key (nothing reads it, validation ignores it) — a one-way
-- migration should never silently destroy the only copy of a number.
UPDATE evalflows
SET config = (config - 'phoneDial' - 'restfulTrigger')
  || CASE WHEN config ? 'phoneDial'
       THEN jsonb_build_object('_legacyPhoneDial', config->'phoneDial')
       ELSE '{}'::jsonb END
WHERE config ? 'phoneDial' OR config ? 'restfulTrigger';
