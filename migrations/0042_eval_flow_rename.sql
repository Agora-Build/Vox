-- evalflow → eval_flow: align the last member of the eval-* family.
--
-- Eval Sets, Eval Jobs and Eval Agents are `eval_sets`/`EvalSet`/
-- `/api/eval-sets`/"Eval Sets" at every layer; PR #175 renamed workflow →
-- evalflow as ONE word and so missed the pattern it was joining. This makes
-- the family uniform: eval_flows / EvalFlow / /api/eval-flows / "Eval Flows".
-- No compatibility shims, same rule as #175 — old API paths are removed, not
-- aliased.
--
-- Constraint/index names inherited from RENAME keep their historical
-- `workflows_*` spellings (they survived #175 the same way) — deliberately
-- not chased, because assuming constraint names is exactly what crash-looped
-- prod on 0037.
ALTER TABLE "evalflows" RENAME TO "eval_flows";
--> statement-breakpoint
ALTER TABLE "eval_jobs" RENAME COLUMN "evalflow_id" TO "eval_flow_id";
--> statement-breakpoint
ALTER TABLE "eval_schedules" RENAME COLUMN "evalflow_id" TO "eval_flow_id";
--> statement-breakpoint
-- NOTE: this UPDATE rewrites every historical eval_jobs row — expect a brief
-- pre-start pause at deploy (the same class as 0036's backfill and #175's own
-- key rewrite; the app is down during migrations, so it reads as slow startup,
-- not a hang).
-- The snapshot KEY spelling moves to camelCase to match its sibling
-- `snapshot.evalSet`; content is preserved byte-for-byte. The immutability
-- invariant protects provenance CONTENT, not key names, and single-path
-- readers (tier SQL) follow in the same release.
UPDATE eval_jobs
SET snapshot = (snapshot - 'evalflow') || jsonb_build_object('evalFlow', snapshot->'evalflow')
WHERE jsonb_typeof(snapshot) = 'object' AND snapshot ? 'evalflow';
--> statement-breakpoint
-- 0017's expression indexes (recreated on the 'evalflow' key by 0039) anchor
-- on the OLD key again — without this the mainline/community tier queries
-- seq-scan eval_jobs. Plain DROP by exact name is safe: 0039 created these
-- names unconditionally.
DROP INDEX eval_jobs_snap_wf_visibility_idx;
--> statement-breakpoint
DROP INDEX eval_jobs_snap_wf_mainline_idx;
--> statement-breakpoint
CREATE INDEX eval_jobs_snap_wf_visibility_idx ON eval_jobs ((snapshot->'evalFlow'->>'visibility'));
--> statement-breakpoint
CREATE INDEX eval_jobs_snap_wf_mainline_idx ON eval_jobs ((snapshot->'evalFlow'->>'isMainline'));
