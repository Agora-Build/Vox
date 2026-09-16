-- R2 (designs/2026-09-10-organizations-seam-design.md §11): freeze the team-pool
-- claim decision at job creation. The claim SQL stops joining users and reads this
-- stamped column instead, so a pending team job stays claimable after its creator
-- leaves the org (bounded by pending-job lifetime). No FK: org ids are opaque
-- integers in Core — a plugin provider may own the organizations table.
ALTER TABLE "eval_jobs" ADD COLUMN "creator_org_id" integer;
--> statement-breakpoint
-- Backfill pre-existing rows from live membership, so in-flight pending jobs keep
-- exactly the claimability they had the instant before this migration ran.
UPDATE eval_jobs SET creator_org_id = u.organization_id
FROM users u WHERE eval_jobs.created_by = u.id AND eval_jobs.creator_org_id IS NULL;
