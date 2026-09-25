-- workflow → evalflow (designs/2026-09-25-unified-workflow-steps-design.md §8):
-- full rename, no legacy compatibility. Constraint/index names inherited from
-- RENAME keep their old spellings — deliberately not chased (harmless, and the
-- 0037 incident showed constraint-name assumptions are how migrations break).
ALTER TABLE "workflows" RENAME TO "evalflows";
--> statement-breakpoint
ALTER TABLE "eval_jobs" RENAME COLUMN "workflow_id" TO "evalflow_id";
--> statement-breakpoint
ALTER TABLE "eval_schedules" RENAME COLUMN "workflow_id" TO "evalflow_id";
--> statement-breakpoint
-- NOTE: this UPDATE rewrites every historical eval_jobs row — expect a brief
-- pre-start pause on deploy (same class as 0036's backfill; the app is down
-- during migrations, so it reads as slow startup, not a hang).
-- Snapshot KEY spelling migrated once, content byte-for-byte: the immutability
-- invariant protects provenance CONTENT, not key names; single-path readers
-- (tier SQL reads snapshot->'evalflow') follow in the same release.
UPDATE eval_jobs SET snapshot = (snapshot - 'workflow') || jsonb_build_object('evalflow', snapshot->'workflow')
  WHERE snapshot ? 'workflow';
