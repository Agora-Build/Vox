-- voice-agent-tester removal (PR #177): aeval is the only eval framework.
--
-- A voice-agent-tester evalflow cannot run, cannot be edited (the validator
-- rejects both its framework and its `app` key), and has no Setup Steps to
-- fall back on — converting it to aeval would leave an unrunnable row that
-- schedules kept firing against a target nobody configured. So it is DELETED
-- outright. Prod has none; other instances may.
--
-- Deleting is safe by design: evalflow_id is ON DELETE SET NULL on both
-- eval_schedules and eval_jobs. An orphaned schedule is disabled by the
-- scheduler on its next tick (it logs "references a deleted evalflow/eval-set
-- — disabling"), and completed jobs keep their history and results,
-- authorized by created_by.

-- A `running` job whose agent is mid-execution reports completion later;
-- finalizeRunningJob only transitions FROM `running`, so that report finds
-- the row already terminal and returns undefined — it cannot overwrite this
-- `failed` with `completed`, and the reap-settle sweep stays correct.
--
-- Queued jobs first — FAIL rather than delete, so a shared-dispatch row stays
-- visible to the scheduler's reap-settle sweep (it picks up `failed` rows with
-- a settlementContext 1–15 min after completed_at, and the worker ticks every
-- minute from startup) and its escrow hold is released. Deleting the row would
-- strand the hold until the 26h leak-reaper.
-- Two shapes qualify: an explicit framework, and IMPLICIT VAT (an `app`
-- payload, no explicit framework, no steps) which relied on an old agent's
-- EVAL_FRAMEWORK default and would otherwise run as aeval with nothing to set
-- up.
UPDATE eval_jobs
SET status = 'failed',
    error = 'voice-agent-tester was removed; re-create this eval on aeval',
    completed_at = NOW()
WHERE status IN ('pending', 'running')
  AND jsonb_typeof(config) = 'object'
  AND (config->>'framework' = 'voice-agent-tester'
       OR (config ? 'app'
           AND config->>'framework' IS DISTINCT FROM 'aeval'
           AND coalesce(btrim(config->>'stepsPrefix'), '') = ''
           AND coalesce(btrim(config->>'stepsSuffix'), '') = ''));
--> statement-breakpoint
-- Disable their schedules BEFORE the delete — afterwards evalflow_id is NULL
-- and the association is gone. Not redundant with the scheduler's
-- orphan-disable: getDueSchedules only selects rows whose next_run_at has
-- arrived, so an orphaned schedule would otherwise sit "enabled" in the UI
-- until its next fire time. An unsupported framework disables the schedule,
-- full stop.
UPDATE eval_schedules SET is_enabled = false
WHERE evalflow_id IN (
  SELECT id FROM evalflows
  WHERE jsonb_typeof(config) = 'object'
    AND (config->>'framework' = 'voice-agent-tester'
         OR (config ? 'app'
             AND config->>'framework' IS DISTINCT FROM 'aeval'
             AND coalesce(btrim(config->>'stepsPrefix'), '') = ''
             AND coalesce(btrim(config->>'stepsSuffix'), '') = ''))
);
--> statement-breakpoint
-- DELETE only rows that PROVABLY declared the removed framework. The
-- "implicit VAT" shape (an `app` payload, no explicit framework, no steps)
-- merely *probably* relied on an old agent's EVAL_FRAMEWORK default — it
-- could equally be an aeval row with junk in it. Deletion is irreversible,
-- so ambiguity keeps the row: its schedules were disabled above (nothing
-- runs quietly wrong) and its dead `app` key is dropped below, leaving a
-- human to decide. Queued jobs of BOTH shapes were failed regardless —
-- failing a job destroys nothing.
-- To triage the kept rows after deploy (they have no steps, so they'd run
-- as aeval with nothing set up, and their schedules are already off):
--   SELECT id, name, owner_id FROM evalflows
--   WHERE config->>'framework' IS NULL
--     AND coalesce(btrim(config->>'stepsPrefix'), '') = ''
--     AND coalesce(btrim(config->>'stepsSuffix'), '') = '';
DELETE FROM evalflows
WHERE config->>'framework' = 'voice-agent-tester';
--> statement-breakpoint
-- Survivors carrying a stray `app` (a healthy aeval row, or an ambiguous
-- implicit one kept above): drop the dead key so the save-time validator
-- never blocks a future edit. Nothing ever read it.
UPDATE evalflows
SET config = config - 'app'
WHERE jsonb_typeof(config) = 'object' AND config ? 'app';
--> statement-breakpoint
-- Eval sets too: validateEvalSetConfig now rejects `app` AND `framework`
-- (both evalflow-only), and v1 eval-set create did NO validation before this
-- release, so an older row may carry either. `framework` matters most:
-- mergeEvalConfig lets the eval set win (`{...wf, ...es}`), so a stray
-- `voice-agent-tester` there would slip past every gate — which reads the
-- EVALFLOW's config — and only fail at the daemon (or, if the evalflow names
-- aeval, throw a merge conflict on every run and scheduler tick).
UPDATE eval_sets
SET config = config - 'app' - 'framework'
WHERE jsonb_typeof(config) = 'object'
  AND (config ? 'app' OR config ? 'framework');
--> statement-breakpoint
-- Unrelated to VAT, same class of cleanup: 0040 parked unconvertible dial
-- numbers as _legacyPhoneDial on the evalflow row, and jobs merged before
-- mergeEvalConfig learned to strip parked keys froze a copy in their own
-- config and snapshot. That copy travels to whichever agent claims the job and
-- is readable by whoever RAN the evalflow (anyone may run a public one), for a
-- key nothing reads. Remove the copies; the evalflow row keeps the original.
-- jsonb_typeof guards on BOTH sides: the WHERE is an OR, so a row can match
-- on one side while the other holds a JSON scalar (JSON `null` is not SQL
-- NULL) — and `scalar - 'key'` raises "cannot delete from scalar", aborting
-- a migration that runs before the app starts. Normal rows can't reach this;
-- 0037 is why the guard is worth its two lines anyway.
UPDATE eval_jobs
SET config = CASE
      WHEN jsonb_typeof(config) = 'object' THEN config - '_legacyPhoneDial'
      ELSE config END,
    snapshot = CASE
      WHEN jsonb_typeof(snapshot #> '{evalflow,config}') = 'object'
        THEN jsonb_set(snapshot, '{evalflow,config}',
               (snapshot #> '{evalflow,config}') - '_legacyPhoneDial')
      ELSE snapshot END
WHERE (jsonb_typeof(config) = 'object' AND config ? '_legacyPhoneDial')
   OR (jsonb_typeof(snapshot #> '{evalflow,config}') = 'object'
       AND snapshot #> '{evalflow,config}' ? '_legacyPhoneDial');
