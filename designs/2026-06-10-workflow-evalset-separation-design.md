# Workflow / Eval-Set Separation — Design

**Date:** 2026-06-10
**Branch:** `feat/workflow-evalset-separation`
**Status:** Approved design, ready for implementation plan

## Problem

A single aeval test (e.g. `examples/turn_taking`) is one logical thing — a set of
sample-driven turns — but running it against different providers needs different
*platform setup*. Agora requires a login/auth step before joining a channel;
LiveKit just joins. Today the test "body" and the platform setup are entangled:
both `workflows.config` and `evalSets.config` are flat JSONB blobs, the old seed
model duplicated `scenario` in both, and nothing enforces which side owns what.

We want a clean separation:

- **Workflow** = the platform-specific *how to connect* (setup/teardown, credentials).
  Different per provider.
- **Eval set** = the provider-agnostic *what to test* (the sample body). One eval
  set shared across providers.
- **vox-eval-agentd** merges workflow setup/teardown around the eval-set body, and
  decides whether to split the merged scenario into multiple chunk files.

The daemon-side merge already exists (uncommitted on this branch). This design
formalizes the separation across the whole stack with a **strict disjoint**
contract.

## Goals

- A strict, validated contract for which config keys belong to a workflow vs. an
  eval set.
- Server-side enforcement (400 on violation) at create/update time.
- A one-time data migration to clean existing rows.
- Seed data and UI that reflect and support the split.
- Test coverage for the merge engine and the validation boundary.

## Non-Goals

- Restructuring `config` into nested namespaces (rejected — over-engineered for a
  two-field split; violates KISS).
- Changing the daemon's merge/chunk algorithm (it already works; we only add tests).
- Multi-language / corpus changes inside aeval.

## The Config Contract

Both configs stay **flat JSONB**. Ownership is disjoint and role-based.

| Key | Owner | Purpose |
|---|---|---|
| `framework` | **Workflow** | `aeval` \| `voice-agent-tester` |
| `app` | **Workflow** | voice-agent-tester app YAML (string) |
| `stepsPrefix` | **Workflow** | aeval platform setup/login/enter steps (YAML array) |
| `stepsSuffix` | **Workflow** | aeval platform exit/teardown steps (YAML array) |
| `url`, credentials, other strings | **Workflow** | connection params resolved via `${config.*}` |
| `scenario` | **Eval set** | the test body: `params.lab` + `analysis` + `lab.trace` sample steps (inline YAML string) |
| `turns` and benign metadata | **Eval set** | non-executable metadata |

**Rules (strict disjoint):**

1. `scenario` may appear **only** in an eval set.
2. `framework`, `app`, `stepsPrefix`, `stepsSuffix` may appear **only** in a workflow.
3. Role-disjointness (rules 1–2) is enforced by the validators. Other keys may
   legitimately appear in both configs (e.g. `frameworkVersion`); at merge time
   they may carry the **same** value, but must not **conflict**.

A role violation is a validation error returned to the client (HTTP 400). Defense
in depth: `mergeEvalConfig` throws if the two configs share a key with
**conflicting values** (identical shared values are allowed — the eval set's
value is used).

### Note on `scenario` semantics

`config.scenario` is now **inline YAML content**, not a filename. The daemon parses
it with `yaml.load(scenario)` and writes it to a temp file. The old seed value
`scenario: "basic_conversation.yaml"` (a filename reference) is stale and gets
replaced with inline body YAML.

## Architecture & Data Flow

```
Workflow.config (per provider)        EvalSet.config (shared)
  framework, app,                       scenario:  (inline YAML)
  stepsPrefix, stepsSuffix,               params.lab: {suite, case_id, sample_ids}
  url/creds                               analysis: {preset, report}
        │                                 steps: [lab.trace, audio.play, ...]
        └──────────────┬──────────────────────────┘
                       ▼
       mergeEvalConfig(workflow, evalSet)   ← server, rejects conflicts
                       ▼
                  job.config  (flat)
                       ▼
        vox-eval-agentd  (resolves ${config.*} / ${secrets.*})
                       ▼
   executeAevalWithChunking(scenario, {stepsPrefix, stepsSuffix})
                       │
        ┌──────────────┴───────────────┐
   body is clean lab.trace?        body has control.for_each / mixed?
        │ yes                          │ no
        ▼                              ▼
   runChunked: split per case_id   composeScenarioYaml: ONE file
   prefix + chunk + suffix         prefix + body + suffix
        ▼                              ▼
   run aeval per chunk, merge      run aeval once
```

## Components

### 1. Server validation — `server/storage.ts`

Replace the single `validateEvalConfig` with two role-aware validators:

- `validateWorkflowConfig(config)`:
  - Keeps existing checks: object (not array), `framework ∈ {aeval, voice-agent-tester}`,
    `app` is string, size ≤ `MAX_CONFIG_SIZE`.
  - **Rejects** the presence of a `scenario` key:
    `"scenario belongs to the eval set, not the workflow"`.
- `validateEvalSetConfig(config)`:
  - Object (not array), `scenario` is a string if present, size ≤ `MAX_CONFIG_SIZE`.
  - **Rejects** any of `framework`, `app`, `stepsPrefix`, `stepsSuffix`:
    `"<key> belongs to the workflow, not the eval set"`.

Both return `{ valid: boolean; error?: string }` (same shape as today).

### 2. Server merge — `server/storage.ts`

`mergeEvalConfig(workflowConfig, evalSetConfig)`:
- Find keys present in both configs whose values **differ** (deep-compared via
  JSON). If any exist, `throw` listing them — this catches a workflow and eval set
  disagreeing on a shared key (e.g. `frameworkVersion`) and guards the scheduler
  and any non-validated path.
- Keys shared with identical values are fine. Spread `{ ...workflow, ...evalSet }`
  (eval set wins, though for identical shared values it makes no difference).
- Role-key contamination (`scenario` in a workflow, etc.) cannot reach here once
  the validators are wired — they reject it at the API boundary first.

### 3. Route wiring — `server/routes.ts`

- Workflow create (`POST /api/workflows`) and update (`PATCH /api/workflows/:id`):
  call `validateWorkflowConfig`.
- Eval-set create (`POST /api/eval-sets`) and update (`PATCH /api/eval-sets/:id`):
  call `validateEvalSetConfig`.
- Existing call sites currently use `validateEvalConfig`; replace each with the
  role-appropriate validator. (Find via `grep validateEvalConfig server/routes.ts`.)
- The merge path (`POST /api/workflows/:workflowId/run` and the scheduler in
  `server/index.ts`) is unchanged structurally — `mergeEvalConfig` now rejects
  conflicting shared-key values.

### 4. Data migration — `migrations/0010_*.sql` + `server/migrate.ts`

- New SQL file: strip `scenario` from every workflow row:
  ```sql
  UPDATE workflows SET config = config - 'scenario'
  WHERE config ? 'scenario';
  ```
  (Postgres `-` removes a top-level jsonb key; `?` tests key presence. Plain SQL,
  no `IF NOT EXISTS` tricks, per the migration rules.)
- Register as `{ version: 11, description: "strip scenario from workflow configs", file: "0010_strip_workflow_scenario.sql" }`
  in the `MIGRATIONS` array in `server/migrate.ts`.
- No `shared/schema.ts` change, so this is hand-written (not produced by
  `drizzle-kit generate`).

### 5. Daemon — `vox_eval_agentd/` (already implemented)

The uncommitted diff is the merge engine and stays as-is:
- `chunking.ts`: `composeScenarioYaml(scenario, prefix, body, suffix)` — wraps a
  non-chunkable body in workflow setup/teardown, preserving `name`/`description`/
  `analysis`/`params`.
- `vox-agentd.ts`: `executeAevalWithChunking` parses `stepsPrefix`/`stepsSuffix`,
  extracts the body's sample groups, and chooses:
  - **chunk** when the body is clean `lab.trace` samples with no leading/trailing
    non-sample steps → `runChunked` (split per `case_id`, wrap each chunk in
    prefix/suffix, run sequentially, merge metrics);
  - **compose one file** otherwise (`control.for_each`, mixed, or no `lab.trace`).

No rewrite. We only add test coverage (§7).

### 6. Seed data — `scripts/seed-data.ts`

Reshape to demonstrate the split (local dev only):

- **Shared eval set** "Basic Conversation Test":
  `config: { scenario: <inline body YAML> }` — `params.lab` + `analysis` +
  `lab.trace`/`audio.play` sample steps, **no** platform setup. Replaces the stale
  `scenario: "basic_conversation.yaml"` + `turns`.
- **LiveKit workflow**: `config: { framework: "aeval", stepsPrefix: <enter steps>, stepsSuffix: <exit steps> }` — **no** `scenario`.
- **Agora workflow** (new): same body via the shared eval set, but `stepsPrefix`
  includes login/auth steps before enter — demonstrating provider-specific setup.

Both workflows run the same eval set, proving the separation.

### 7. UI

- `client/src/pages/console-workflows.tsx`:
  - Add `stepsPrefix` / `stepsSuffix` YAML textareas for the aeval framework
    (create + edit dialogs), plus connection-param editing (e.g. `url`).
  - Ensure no `scenario` field is offered on the workflow side.
  - Surface the `validateWorkflowConfig` error message on 400.
- `client/src/pages/console-evalsets.tsx`:
  - Already edits `config.scenario` (body-oriented). Add a helper hint: "Body only
    — no platform setup; that lives in the workflow."
  - Surface the `validateEvalSetConfig` error message on 400.

### 8. Tests

- `tests/eval-chunking.test.ts`:
  - `composeScenarioYaml`: metadata (`name`/`description`/`analysis`/`params`)
    preserved; `steps` ordered prefix → body → suffix.
  - chunk-vs-compose branch: clean `lab.trace` body chunks per `case_id`;
    `control.for_each` body composes into one file.
- `tests/api.test.ts`:
  - `scenario` in a workflow config → 400.
  - `framework` / `stepsPrefix` in an eval-set config → 400.
  - Valid disjoint workflow + eval set → `mergeEvalConfig` produces the expected
    combined `job.config`.

## Error Handling

- Validation failures return 400 with a specific message naming the offending key
  and where it belongs.
- `mergeEvalConfig` throws (500) if a workflow and eval set share a key with
  conflicting values — a config mistake worth surfacing in server logs. Identical
  shared values (e.g. matching `frameworkVersion`) merge cleanly.
- Daemon failure policy is unchanged: non-zero aeval exit → job failed, no partial
  results reported.

## Testing Strategy

- Unit: validators (both roles, accept + reject paths), `mergeEvalConfig`
  conflict detection (throws on differing shared values, allows identical),
  `composeScenarioYaml`.
- Integration (`tests/api.test.ts`): create/update workflow and eval set with valid
  and invalid configs; run-workflow merge result.
- Pre-push gate (per project convention): `npm run check` + `npm test`.

## Migration & Rollout

1. Ship migration `0010` — strips `scenario` from existing workflow rows on startup.
2. Validation rejects new violations going forward.
3. Re-seed local dev (`dev-local-run.sh reset`) to get the new shared-eval-set
   shape and the Agora + LiveKit workflows.

## Open Questions

None outstanding. Field ownership, migration strategy (one-time SQL), and keeping
the daemon diff as the merge engine are all confirmed.
