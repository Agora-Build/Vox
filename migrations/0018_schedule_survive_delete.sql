-- Let a schedule survive deletion of its workflow/eval-set (skipped by the
-- scheduler thereafter), instead of cascading it away (workflow) or throwing a FK
-- error (eval-set, which had ON DELETE NO ACTION). Consistent with jobs surviving.
ALTER TABLE "eval_schedules" ALTER COLUMN "workflow_id" DROP NOT NULL;
ALTER TABLE "eval_schedules" ALTER COLUMN "eval_set_id" DROP NOT NULL;

ALTER TABLE "eval_schedules" DROP CONSTRAINT "eval_schedules_workflow_id_workflows_id_fk";
ALTER TABLE "eval_schedules" ADD CONSTRAINT "eval_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "eval_schedules" DROP CONSTRAINT "eval_schedules_eval_set_id_eval_sets_id_fk";
ALTER TABLE "eval_schedules" ADD CONSTRAINT "eval_schedules_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE set null ON UPDATE no action;
