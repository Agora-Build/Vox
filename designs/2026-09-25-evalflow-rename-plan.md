# workflow → evalflow Rename Implementation Plan (PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Full rename, zero legacy compatibility, **zero behavior change** — a pure-rename diff reviewable as such. Ships before the unified-steps PR so that work lands on clean names.

**Spec:** `designs/2026-09-25-unified-workflow-steps-design.md` §8. Also sweeps the direction-terminology inversion (§1 callout) in docs/comments touched along the way.

## Global Constraints

- **No behavior change.** Every commit leaves `npm run check` (both projects) green; the gate runs once at the end.
- **No compat shims**: old API paths removed, snapshot keys migrated (content byte-for-byte), no dual-reads.
- Migration is hand-written `0039_*.sql`, registered `{version: 40}` in `server/migrate.ts`; local dev applies via `db:push` + manual version-row bump to 40 + the snapshot-key UPDATE run by hand (db:push doesn't run migrations).
- Branch `feat/evalflow-rename`; merge only on the user's mark. Coolify deploys on merge — the migration renames live tables, so the deploy is the cutover (stop-then-start not required: single ALTER RENAMEs are instant and the old container's queries fail loudly for seconds at worst; acceptable per no-compat).
- Prod data to double-check post-deploy: workflow/evalflow 18, job 34168's snapshot key.

## Task 1: Database migration

**Create `migrations/0039_evalflow_rename.sql`:**
```sql
-- workflow → evalflow (design 2026-09-25 §8): full rename, no compat.
ALTER TABLE "workflows" RENAME TO "evalflows";
--> statement-breakpoint
ALTER TABLE "eval_jobs" RENAME COLUMN "workflow_id" TO "evalflow_id";
--> statement-breakpoint
ALTER TABLE "eval_schedules" RENAME COLUMN "workflow_id" TO "evalflow_id";
--> statement-breakpoint
-- Snapshot KEY spelling migrated once, content byte-for-byte (immutability
-- protects provenance content, not key names; single-path readers after this).
UPDATE eval_jobs SET snapshot = (snapshot - 'workflow') || jsonb_build_object('evalflow', snapshot->'workflow')
  WHERE snapshot ? 'workflow';
```
- [ ] Inventory FIRST, then extend the SQL: `\d` every table for other `workflow_id` columns (grep schema.ts for `workflow`), expression indexes on `snapshot->'workflow'` (`\di+` / pg_indexes) — rename/rebuild in the same migration. Constraint names from RENAME stay as-is (harmless; note in the file header — do NOT chase constraint renames, see the 0037 FK-name lesson).
- [ ] Register `{version: 40, ...}`; apply locally (`db:push`, stamp version 40, run the snapshot UPDATE manually); verify workflow 18 visible as `evalflows` row and job 34168's snapshot has `evalflow` key.

## Task 2: Shared schema + server

- [ ] `shared/schema.ts`: `workflows`→`evalflows` table object + `pgTable("evalflows")`, `workflowId`→`evalflowId` columns, `Workflow`/`InsertWorkflow` types → `Evalflow`/`InsertEvalflow`, `insertWorkflowSchema`→`insertEvalflowSchema`, `JobSnapshot.workflow`→`evalflow`.
- [ ] `server/`: mechanical sweep (`grep -rn workflow server/ --include='*.ts' -il`) — storage methods (`getWorkflow`→`getEvalflow`, …), `buildJobSnapshot`, claim/tier SQL strings (`snapshot->'workflow'`→`'evalflow'`, `workflow_id`→`evalflow_id`), permissions (`canRunWorkflow`→`canRunEvalflow`, `canScheduleWorkflow`→…), `auth-session.ts` (`workflowNeedsSession`→`evalflowNeedsSession`, `sessionScopeForWorkflow`→…), `validateWorkflowConfig`→`validateEvalflowConfig`, routes: `/api/workflows*`→`/api/evalflows*` (old paths GONE), `orgRuntimeSecretsForJob` internals, scheduler, restful endpoint snapshot reads.
- [ ] `docs/openapi.yaml` + `server/routes-api-v1.ts` paths.
- [ ] `server/sensitive-paths.ts` if any workflow path is listed (its test scans routes.ts — will flag drift).

## Task 3: Daemon + brokers

- [ ] `vox_eval_agentd/`: `EvalJob.workflowId`→`evalflowId` (server serializes camelCase from the renamed column automatically via snakeToCamel), log strings, `phone-eval.ts`/`chunking.ts` comments; **direction-terminology sweep** in comments while here (agent-perspective per the design callout).

## Task 4: Client

- [ ] Pages: `console-workflows.tsx`→`console-evalflows.tsx`, `console-workflow-detail.tsx`→…, routes `/console/workflows*`→`/console/evalflows*` in `App.tsx`, query keys `/api/workflows`→`/api/evalflows`, nav labels + ALL user-visible copy "Workflow"→"Evalflow", run-your-own + realtime + jobs pages' references, `data-testid`s.

## Task 5: Tests, docs, data

- [ ] Test sweep (`grep -rln workflow tests/`): API paths, storage calls, snapshot fixtures (`snapshot: {workflow: …}`→`{evalflow: …}`), E2E selectors/paths, boundary-test expectations if they name tables.
- [ ] CLAUDE.md full sweep (also the direction-terminology fixes); memory update post-merge.
- [ ] Prod after deploy: verify `/api/evalflows` serves, evalflow 18 + eval set 28 run path intact, realtime My Evals (Phone) still shows job 34168 (proves snapshot-key migration + tier SQL agree).

## Task 6: Gate + PR

- [ ] `npm run check`; clean DB; full `npm test` + `./scripts/full-tests-run.sh` with isolate-rerun classification; local docker builds (service implicit via CI PR gate; daemon target) — then PR titled `refactor: rename workflow → evalflow (no compat)`, body stating "pure rename, zero behavior change"; **no merge without the mark**.

## Self-review notes
- The rename is mechanical but WIDE — the discipline is: sweep by grep inventory, not memory; every commit typechecks; behavior assertions come from the existing suites passing unmodified except for renamed identifiers/paths.
- Deliberately NOT renamed: `vox_clash_runner` internals unrelated to workflows; DialF/Libretto docs (their own domains); historical PR/commit text.
