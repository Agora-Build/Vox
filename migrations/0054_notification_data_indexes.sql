CREATE INDEX IF NOT EXISTS eval_jobs_personal_notifications_idx
  ON eval_jobs(created_by,created_at DESC)
  WHERE creator_org_id IS NULL AND kind='eval' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_results_notification_job_idx
  ON eval_results(eval_job_id,created_at DESC);
