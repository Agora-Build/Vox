# Phone vs Agent — Phase A (Transport Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `transport` axis (web|phone) across schema, snapshot, dispatch gating, agent capabilities, results, and metrics endpoints — everything later phases (REST broker, DialF integration, UI) build on — with zero behavior change for existing web evals.

**Architecture:** One new enum column on `workflows` (`transport`, default `web`), frozen into each job (snapshot field + stamped `eval_jobs.transport` column for claim SQL, mirroring the `creator_org_id` precedent), a `capabilities` declaration on eval agents gating phone-job claims, a nullable `call_metadata` jsonb on results, and a `transport` query param on the three metrics endpoints (default `web` — never mixed).

**Tech Stack:** Drizzle (schema in `shared/schema.ts`), hand-written SQL migration (drizzle-kit generate is inoperative), Express routes in `server/routes.ts`, raw-SQL claim path in `server/storage.ts`, Vitest integration tests against the running dev server.

**Spec:** `designs/2026-09-21-phone-vs-agent-design.md` (§3 evaluation model, §8 dispatch, §7 callMetadata, §11 realtime plumbing). Phases B (REST broker), C (DialF, requires DialF ≥ v0.3.8), D (UI) are separate plans.

## Global Constraints

- Migration `0038_*.sql` is **hand-written** plain SQL (no `IF NOT EXISTS`), registered in `MIGRATIONS` in `server/migrate.ts` as `{ version: 39, ... }`. Schema change + migration commit together.
- Local dev applies schema via `db:push`; **after any manual push, restore the `_schema_version` row to 39** or docker-mode start crash-loops (CLAUDE.md dev-mode migration trap).
- Integration tests hit the **already-running** dev server — restart (`./scripts/dev-local-run.sh stop && start`) after `server/` changes, before running them.
- Tests needing direct DB access follow the `tests/org-claim-stamp.test.ts` pattern (import `{ storage, pool }` from `../server/storage`, guard on `process.env.DATABASE_URL`); run with `.env`/`.env.dev` sourced.
- Claim SQL and `permissions.isClaimable()` **mirror each other bit for bit** — every gating change lands in both.
- No UI changes in this phase (Phase D). No behavior change for `transport='web'` workflows anywhere.
- Work on branch `feat/phone-transport-phase-a`; commits signed `🤖 Built with SMT <smt@agora.build>`.

---

### Task 1: Schema + migration 0038

**Files:**
- Modify: `shared/schema.ts` (4 additions: enum near line 10; `workflows` ~line 166; `evalAgents` ~line 245; `evalJobs` ~line 367; `evalResults` — find `callMetadata` insertion point next to the metric columns ~line 449)
- Create: `migrations/0038_phone_transport.sql`
- Modify: `server/migrate.ts` (append to `MIGRATIONS`, after the `version: 38` entry at line 62)

**Interfaces:**
- Produces: `transportEnum` pg enum `transport ('web','phone')`; columns `workflows.transport` (notNull default `'web'`), `evalJobs.transport` (notNull default `'web'`), `evalResults.callMetadata` (jsonb nullable), `evalAgents.capabilities` (jsonb notNull default `[]`). Types `Workflow`/`EvalJob`/`EvalResult`/`EvalAgent` gain the fields via `$inferSelect` automatically; `insertWorkflowSchema` picks up `transport` via `createInsertSchema`.

- [ ] **Step 1: Add the enum + columns in `shared/schema.ts`**

Next to the existing enums (line ~10, beside `providerSkuEnum`):

```ts
// Conversation transport of a convo eval (design 2026-09-21 §3): how the simulated
// user reaches the agent. Orthogonal to providers.sku (the eval KIND axis).
export const transportEnum = pgEnum("transport", ["web", "phone"]);
```

In `workflows` (after `isMainline`):

```ts
  transport: transportEnum("transport").default("web").notNull(),
```

In `evalJobs` (after `creatorOrgId` — same frozen-at-creation pattern, commented):

```ts
  // Frozen at creation from the workflow (like creator_org_id): the claim SQL
  // gates phone jobs on THIS, never the live workflow row.
  transport: transportEnum("transport").default("web").notNull(),
```

In `evalAgents` (after `metadata`):

```ts
  // Capability declaration from register/heartbeat (e.g. ["phone"]). Claim SQL
  // requires "phone" for phone-transport jobs.
  capabilities: jsonb("capabilities").default([]).notNull(),
```

In `evalResults` (after the `turnSuccessRate` column ~line 464):

```ts
  // Phone-transport call metadata (design §7): {callId, disposition, answeredAfterMs,
  // durationMs, fromRedacted, sim}. NULL for web results.
  callMetadata: jsonb("call_metadata"),
```

- [ ] **Step 2: Write `migrations/0038_phone_transport.sql`** (plain SQL, style of `0036_eval_jobs_creator_org_id.sql`):

```sql
-- Phone vs Agent Phase A (designs/2026-09-21-phone-vs-agent-design.md §3, §7, §8):
-- transport axis (web|phone) on workflows, frozen per-job for claim gating;
-- agent capability declaration; phone call metadata on results.
CREATE TYPE "transport" AS ENUM ('web', 'phone');
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "transport" "transport" DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "transport" "transport" DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "call_metadata" jsonb;
```

(No backfill needed: every pre-existing row IS web — the default is the truth.)

- [ ] **Step 3: Register in `server/migrate.ts`** after the version-38 entry:

```ts
  { version: 39, description: "Phone vs Agent Phase A: transport axis, agent capabilities, call metadata", file: "0038_phone_transport.sql" },
```

Confirm `TARGET_VERSION` derives from the list (it does — verify, don't hardcode).

- [ ] **Step 4: `npm run check`** — expect clean.

- [ ] **Step 5: Apply locally + restore version bookkeeping**

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:push
docker exec vox-postgres psql -U vox -d vox -c "UPDATE _schema_version SET version = 39;"
docker exec vox-postgres psql -U vox -d vox -c "SELECT column_name FROM information_schema.columns WHERE table_name='workflows' AND column_name='transport';"
```

Expected: the SELECT returns one row. If `db:push` prompts interactively about the new enum, answer "create".

- [ ] **Step 6: Commit** — `git add shared/schema.ts migrations/0038_phone_transport.sql server/migrate.ts && git commit` (message: `feat(phone): transport axis schema + migration 0038`).

---

### Task 2: Snapshot + job stamping

**Files:**
- Modify: `shared/schema.ts` (the `JobSnapshot` type, line ~340)
- Modify: `server/storage.ts` (`buildJobSnapshot` line ~299; `createEvalJob` — the insert near line ~937)
- Test: `tests/phone-transport.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `JobSnapshot.transport: "web" | "phone"`; `buildJobSnapshot()` reads it from `workflow.transport`; `createEvalJob` stamps `eval_jobs.transport` from the snapshot (single choke point — covers the run route AND the scheduler with no caller changes).

- [ ] **Step 1: Write the failing test** (`tests/phone-transport.test.ts`, `org-claim-stamp.test.ts` structure: `beforeAll` guard on `DATABASE_URL`, direct `storage` imports, unique `phoneA-<ts>` names, `afterAll` deletes everything it created):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("phone transport — snapshot + stamp", () => {
  it("freezes transport at job creation; later workflow edits don't rewrite it", async () => {
    if (!process.env.DATABASE_URL) return;
    const { storage, buildJobSnapshot } = await import("../server/storage");
    // seed: provider (reuse a seeded one), phone workflow, eval set, job
    const providers = await storage.getProviders();
    const wf = await storage.createWorkflow({ name: `phoneA-wf-${Date.now()}`, ownerId: 1,
      providerId: providers[0].id, transport: "phone", visibility: "private", config: {} } as any);
    const snap = buildJobSnapshot(wf, null, providers[0], "principal");
    expect(snap.transport).toBe("phone");
    const job = await storage.createEvalJob({ workflowId: wf.id, createdBy: 1,
      targetRegion: "na", targetTier: "private", config: {}, snapshot: snap } as any);
    expect(job.transport).toBe("phone");
    await storage.updateWorkflow(wf.id, { transport: "web" } as any);
    const reread = await storage.getEvalJob(job.id);
    expect(reread!.transport).toBe("phone");          // frozen
    expect((reread!.snapshot as any).transport).toBe("phone");
  });
});
```

(Adapt seeding calls to the actual `storage` signatures — read the neighboring usage in `tests/org-claim-stamp.test.ts` and copy its seeding idiom exactly. Register cleanup of the workflow + job in `afterAll`.)

- [ ] **Step 2: Run it — expect FAIL** (`snap.transport` undefined):
`set -a; . ./.env; . ./.env.dev; set +a; DATABASE_URL=... npx vitest run tests/phone-transport.test.ts`

- [ ] **Step 3: Implement**

`JobSnapshot` (shared/schema.ts) — add after `creatorPlan`:

```ts
  // Conversation transport frozen at creation (design 2026-09-21 §3). Absent on
  // pre-existing snapshots ⇒ treat as "web".
  transport?: "web" | "phone";
```

`buildJobSnapshot` — add to the returned object:

```ts
    transport: (workflow.transport as "web" | "phone" | undefined) ?? "web",
```

`createEvalJob` — at the insert (~line 937), derive the column from the snapshot so every creation path is covered:

```ts
    const transport = (job.snapshot as JobSnapshot | null)?.transport ?? "web";
    // include `transport` in the inserted values object
```

- [ ] **Step 4: Restart dev server, run the test — expect PASS.**

- [ ] **Step 5: Commit** (`feat(phone): freeze transport into job snapshot + stamped column`).

---

### Task 3: Agent capabilities (register/heartbeat/list)

**Files:**
- Modify: `server/routes.ts` — register handler (line ~3616), heartbeat handler (line ~3720), and the agents listing route (`GET /api/eval-agents` — grep it)
- Test: `tests/phone-transport.test.ts` (extend)

**Interfaces:**
- Consumes: `evalAgents.capabilities` (Task 1).
- Produces: register/heartbeat accept optional `capabilities: string[]` (allowed values: `["phone"]` — reject unknown strings with 400); persisted on the agent row each heartbeat (an agent that loses its DialF drops the capability on its next heartbeat — self-healing, design §6); `GET /api/eval-agents` items include `capabilities`.

- [ ] **Step 1: Failing test** — register a token-agent via API with `capabilities: ["phone"]`, assert the listing shows it; heartbeat without capabilities clears it; `capabilities: ["jetpack"]` → 400. Use the existing agent-registration idiom from `tests/api.test.ts` (search "eval-agent/register" there and copy token minting + register flow).

- [ ] **Step 2: Run — expect FAIL** (field ignored / absent from listing).

- [ ] **Step 3: Implement.** In both handlers, after existing body parsing:

```ts
const ALLOWED_CAPABILITIES = ["phone"] as const;
const capabilities: string[] = Array.isArray(req.body.capabilities) ? req.body.capabilities : [];
if (capabilities.some(c => !ALLOWED_CAPABILITIES.includes(c as any))) {
  return res.status(400).json({ error: "Unknown capability" });
}
```

Persist `capabilities` in the same storage update the handler already performs for state/lastSeen (extend the existing `storage` call — do not add a second UPDATE). Add `capabilities: agent.capabilities ?? []` to the listing serializer.

- [ ] **Step 4: Restart dev server, run — expect PASS.**  - [ ] **Step 5: Commit** (`feat(phone): agent capability declaration on register/heartbeat`).

---

### Task 4: Claim gating (SQL + permissions mirror)

**Files:**
- Modify: `server/storage.ts` — `claimEvalJob` (line ~952) and `getClaimableJobsForToken` (line ~1013): identity gains `phoneCapable: boolean`; both WHERE clauses gain the transport arm
- Modify: `server/permissions.ts` — `isClaimable()` mirror
- Modify: `server/routes.ts` — the claim/fetch call sites building `identity` (grep `claimEvalJob(` / `getClaimableJobsForToken(`): compute `phoneCapable = (agent.capabilities as string[] ?? []).includes("phone")`
- Test: `tests/phone-transport.test.ts` (extend)

**Interfaces:**
- Consumes: `eval_jobs.transport` (Task 2), `evalAgents.capabilities` (Task 3).
- Produces: a phone-transport job is invisible/unclaimable for agents without the `phone` capability; web jobs unaffected regardless of capability.

- [ ] **Step 1: Failing test** — both directions (the `org-claim-stamp` pattern): create a phone-transport job targeted at a private-tier pool; a registered agent **without** `phone` gets nothing claimable; the same agent after re-heartbeating **with** `["phone"]` claims it. Then a web job: claimable by a phone-less agent (no regression).

- [ ] **Step 2: Run — expect FAIL** (phone job claimed by capability-less agent).

- [ ] **Step 3: Implement.** In both SQL statements add one AND-arm at the top level of the WHERE (parameter `$8` in `claimEvalJob`, next free index in `getClaimableJobsForToken`):

```sql
           AND ( ej.transport = 'web'::transport OR $8::boolean = true )
```

with `identity.phoneCapable` appended to the params array. Mirror in `permissions.isClaimable()`:

```ts
  // Phone-transport jobs require the phone capability (design §8) — mirrors claim SQL.
  if (job.transport === "phone" && !agentPhoneCapable) return false;
```

(read `isClaimable`'s existing signature first; thread `agentPhoneCapable` the same way `dispatchTier` is threaded — keep the bit-for-bit mirror comment updated.)

- [ ] **Step 4: Restart dev server, run — expect PASS. Also run `npx vitest run tests/tier-pool-claim.test.ts tests/org-claim-stamp.test.ts`** (claim-path regressions).

- [ ] **Step 5: Commit** (`feat(phone): claim gating — phone jobs require phone capability`).

---

### Task 5: Workflow routes accept `transport`

**Files:**
- Modify: `server/routes.ts` — `POST /api/workflows` (line ~1832), `PATCH /api/workflows/:id` (line ~1897)
- Test: `tests/phone-transport.test.ts` (extend, via HTTP like `tests/api.test.ts`)

**Interfaces:**
- Consumes: `insertWorkflowSchema` (already includes `transport` via `createInsertSchema` after Task 1 — verify, don't assume).
- Produces: create accepts `transport` (default `web` when omitted; 400 on values outside the enum via Zod); PATCH allows owner/org-manager to change it (past jobs frozen by Task 2); GET responses include it (automatic via `$inferSelect` — verify one).

- [ ] **Step 1: Failing test (HTTP)** — POST a workflow with `transport: "phone"` → response echoes it; POST without → `"web"`; POST `transport: "carrier-pigeon"` → 400; PATCH flips web→phone → 200 + persisted.

- [ ] **Step 2: Run — expect** the phone POST to fail only if the route strips unknown fields; if it already passes end-to-end via the Zod schema, skip Step 3 and keep the test as a regression lock (state this in the commit message).

- [ ] **Step 3: Implement (only if failing):** ensure the create handler passes `transport` through its validated body (check whether it builds the insert object field-by-field — if so add `transport: parsed.transport`), and add `transport` to the PATCH-allowed fields next to `visibility`.

- [ ] **Step 4: Restart dev server, run — expect PASS.**  - [ ] **Step 5: Commit** (`feat(phone): workflow transport via API`).

---

### Task 6: Results `callMetadata` + metrics `transport` param

**Files:**
- Modify: `server/routes.ts` — job complete/results handler (line ~3927): accept optional `callMetadata`; metrics handlers (lines ~5313/5333/5353): `transport` query param
- Modify: `server/storage.ts` — the metrics query functions those routes call (follow the call chain from the three handlers; add a transport filter joined from `eval_jobs`)
- Test: `tests/phone-transport.test.ts` (extend)

**Interfaces:**
- Consumes: `evalResults.callMetadata`, `eval_jobs.transport`.
- Produces: complete endpoint persists `callMetadata` when it is a plain object ≤ 4 KB serialized (else 400: `"invalid callMetadata"`); `GET /api/metrics/{realtime,community,my-evals}?transport=web|phone` — **default `web`**, invalid value → 400, response rows gain `transport`; web and phone are never mixed in one response (design §11).

- [ ] **Step 1: Failing test** — complete a claimed phone job with `callMetadata: {disposition: "completed", durationMs: 61000}` → stored (read back via storage); `?transport=phone` on my-evals returns the phone result and NOT a web result; no param returns only web rows; `?transport=pigeon` → 400.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Complete handler:

```ts
let callMetadata: unknown = undefined;
if (req.body.callMetadata !== undefined) {
  if (typeof req.body.callMetadata !== "object" || req.body.callMetadata === null
      || Array.isArray(req.body.callMetadata)
      || JSON.stringify(req.body.callMetadata).length > 4096) {
    return res.status(400).json({ error: "invalid callMetadata" });
  }
  callMetadata = req.body.callMetadata;
}
```

Thread it into the result insert. Metrics handlers:

```ts
const transport = (req.query.transport as string | undefined) ?? "web";
if (!["web", "phone"].includes(transport)) return res.status(400).json({ error: "invalid transport" });
```

Pass `transport` into the storage metrics functions; there, add `AND ej.transport = $n::transport` via the results→jobs join (the tiering read at storage.ts:~1570 already touches the job snapshot — put the filter in the same join), and include `transport` in the returned row mapping.

- [ ] **Step 4: Restart dev server, run — expect PASS. Also `npx vitest run tests/api.test.ts -t "Metrics"`** (regression: default behavior unchanged).

- [ ] **Step 5: Commit** (`feat(phone): callMetadata on results + transport param on metrics endpoints`).

---

### Task 7: Gate + docs

**Files:**
- Modify: `CLAUDE.md` (Eval Agent System section: one paragraph on transport/capabilities/callMetadata)
- No other code.

- [ ] **Step 1: Docs** — add to CLAUDE.md's Eval Agent System: workflows carry `transport` (web|phone, frozen per-job like `creatorOrgId`); phone jobs claimable only by agents declaring the `phone` capability; metrics endpoints take `transport=` (default web, never mixed); `evalResults.callMetadata` is phone-only. Reference `designs/2026-09-21-phone-vs-agent-design.md`.
- [ ] **Step 2: Clean the dev DB** (CLAUDE.md hazard SQL: workflows/projects/secrets owner 1 + r2-org cleanup), restart dev server.
- [ ] **Step 3: Full gate** — `./scripts/full-tests-run.sh` with `.env` sourced. Expect green modulo the documented flakes (isolate-rerun any failure to classify; the my-evals `≤5` drift and load-timing E2E flakes are known).
- [ ] **Step 4: Commit docs** (`docs(phone): Phase A conventions in CLAUDE.md`), push branch, open PR titled `feat(phone): transport foundation (Phase A)` — body per repo convention, ending `Generated with SMT <smt@agora.build>`. **Do not merge** — merge waits for the user's mark per convention.

---

## Self-review notes

- Spec coverage: §3 (Task 1/2/5), §8 gating (Task 3/4), §7 callMetadata (Task 6), §11 plumbing (Task 6), §10 table rows all covered; §5/§6 (restful, DialF) intentionally out — Phases B/C; UI §11 — Phase D.
- Type consistency: `transport` is `"web" | "phone"` everywhere; `phoneCapable: boolean` on the claim identity; `capabilities: string[]` validated against `["phone"]`.
- Known execution risk: exact storage seeding signatures in tests and the metrics query call chain must be read at execution time — anchors given (file:line + grep targets); do not invent signatures.
