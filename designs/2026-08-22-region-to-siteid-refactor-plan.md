# `region` → `siteId` Terminology Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the overloaded `region` column/field/helper — which everywhere actually stores a full sequenced *site id* (`na-us-seattle-02`) — to `siteId`, and free the word `region` to mean the real region (`na-us-seattle` → "Seattle").

**Architecture:** A hard-cut rename across four compile/runtime units, applied in dependency order: (1) DB + schema + all server code as one atomic compile unit, (2) the eval-agent daemon, (3) the client, (4) the OpenAPI doc. No backward-compat wire alias — Core and daemon images deploy together. The only genuine new behavior is three client helpers (`regionOf`, a repurposed `formatRegion`, and `formatSite`); everything else is mechanical rename, where `npm run check` is the completeness oracle for typed references and enumerated greps cover the untyped query-param surfaces.

**Tech Stack:** TypeScript, Drizzle ORM + PostgreSQL, Express, React 19 + Vite, Vitest, Playwright, esbuild (daemon).

**Spec:** `designs/2026-08-22-region-to-siteid-refactor-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

Copied from the spec and the project's binding rules. Every task's requirements implicitly include this section.

- **Vocabulary:** `siteId` = `na-us-seattle-02` (region + `-NN` sequence, the value all nine columns store). `region` = `na-us-seattle` (a `region_locations.baseId`, display "Seattle"). `Seattle` = region display name. `na` → North America = macro region / geo.
- **Do NOT touch region-*scope* filters** — `regionScope`, and the `location` / `country` / `macroRegion` query params and their parser branches are genuinely region-level and already correctly named.
- **Do NOT touch AWS S3 region** — `userStorageConfig.s3Region` (schema.ts:447) and the daemon's `S3Config.region` (vox-agentd.ts:190,207, from `S3_REGION`).
- **Do NOT touch historical `snapshot` jsonb keys** — frozen provenance; the job's site is a top-level column (renamed), the snapshot carries no separate region key.
- **Migrations:** new file `migrations/0033_region_to_site_id.sql`, registered as **version 34** in `server/migrate.ts` (latest registered = version 33 / `0032_api_key_soft_delete.sql`). Plain SQL only — no `IF NOT EXISTS`, no `DO`/exception blocks; `--> statement-breakpoint` between statements. **Hand-write the `ALTER TABLE ... RENAME COLUMN`** — do NOT run `db:generate`, which may emit drop+recreate (data loss) for a column rename. Never `db:push` / `drizzle-kit push --force`.
- **Hard cut:** no backward-compat `region` alias on the wire. Coordinated deploy (Core + daemon images via `scripts/vox-upgrade.sh`).
- **Git:** work on branch `feat/region-to-siteid-refactor` (already created; spec committed as f1a7be0). Feature branch only — NO force-push to main, NO merge to main until the user explicitly marks it. Every commit message ends with the line `🤖 Built with SMT <smt@agora.build>`. Never `git stash` (repo has a large pre-existing stash stack). Stage only files relevant to the task.
- **Test gate:** `npm run check` must pass fully (zero TS errors) at the end of every task. Per-task, run the specific vitest files the task touches. `./scripts/full-tests-run.sh` (unit + audio + E2E) runs once at branch finish before any merge. **Baseline caveat:** `tests/api.test.ts` has pre-existing unrelated failures on `main` (caps + `:8099` daemon-health, ~8 fails); a task is green if it introduces **no new** failures vs. the `main` baseline, not if the whole suite is green.

---

## File Structure

**Task 1 — DB + schema + server (one atomic compile unit):**
- Create: `migrations/0033_region_to_site_id.sql` — 9 `RENAME COLUMN` + 2 `RENAME INDEX`.
- Modify: `server/migrate.ts` — register version 34.
- Modify: `shared/schema.ts` — 9 column defs `region`→`siteId`, 2 index defs (name string + `.on()` ref).
- Modify: `server/storage.ts` — `isAllocatedRegion`→`isAllocatedSite`, allocator local var, all row/DTO field accesses.
- Modify: `server/routes.ts` — register response, `/api/eval-agents(/dispatchable)` responses, `parseRegionQueryScope` exact-site branch, metrics responses, schedule validate call, `run-targets` + job-poll + leaderboard query params.
- Modify: `server/routes-api-v1.ts` — dispatch body field + message, `apiRegionScope` exact-site branch, `apiRegionMetadata` input param.
- Modify: `server/index.ts` — scheduler `createEvalJob({ siteId })`.
- Modify (fold): `tests/api.test.ts`, `tests/secrets.test.ts`, `tests/secrets-class-api.test.ts`, `tests/session-dispatch.test.ts`, `tests/eval-jobs.test.ts`, `tests/job-recovery.test.ts`, `tests/clash-runner*.test.ts` — fixtures/fields `region`→`siteId`; drop `?region=` on job-poll fetches.

**Task 2 — Eval-agent daemon (separate esbuild unit):**
- Modify: `vox_eval_agentd/vox-agentd.ts` — `EvalAgent.region`/`EvalJob.region`→`siteId`, `this.siteId`, drop `?region=` poll query, log lines.
- Modify (fold): `tests/eval-agent-daemon.test.ts` — agent/job fixtures `region`→`siteId`; drop `?region=` from poll-URL expectations.

**Task 3 — Client (separate Vite unit):**
- Modify: `client/src/lib/utils.ts` — rename `formatRegion`→`formatSite` (drop dead legacy branch), add `regionOf` + new `formatRegion` + `type SiteId`/`type Region`, rename `REGIONS`→`SITES`.
- Modify: `client/src/hooks/use-regions.ts` — `useRegionOptions`→`useSiteOptions`, `REGIONS` import→`SITES`.
- Modify: 13 page/component files — 21 `formatRegion(...)` call sites → `formatSite(...)`; `useRegionOptions`→`useSiteOptions`; API `.region`→`.siteId`; `run-targets?region=`→`?siteId=`.
- Modify (fold): `tests/regions.test.ts` — site-label assertions→`formatSite`, drop legacy-branch assertions, add `regionOf`/new-`formatRegion` tests; `tests/e2e/api.spec.ts` leaderboard query.

**Task 4 — OpenAPI doc (no compile):**
- Modify: `docs/openapi.yaml` — site-id `region` fields→`siteId`, drop stale `enum: [na, apac, eu, sa]`.

---

### Task 1: DB migration + schema + all server code

The `shared/schema.ts` column rename compile-couples every server file, so the migration, schema, and all server code must land together for `npm run check` to pass. Large but mechanical; the TS compiler enumerates every stale typed reference for you.

**Files:**
- Create: `migrations/0033_region_to_site_id.sql`
- Modify: `server/migrate.ts` (MIGRATIONS array)
- Modify: `shared/schema.ts:209,233,271,351,369,399,429,842,965,987,1021`
- Modify: `server/storage.ts:478,503` (+ all field accesses)
- Modify: `server/routes.ts` (see steps)
- Modify: `server/routes-api-v1.ts:18-39,43-92,300-369`
- Modify: `server/index.ts` (`processScheduledJobs`)
- Test: `tests/api.test.ts`, `tests/secrets.test.ts`, `tests/secrets-class-api.test.ts`, `tests/session-dispatch.test.ts`, `tests/eval-jobs.test.ts`, `tests/job-recovery.test.ts`, `tests/clash-runner.test.ts`, `tests/clash-runner-lifecycle.test.ts`

**Interfaces:**
- Produces (wire, consumed by Tasks 2–4): eval-agent register response field `siteId`; each job object field `siteId`; `/api/eval-agents` + `/dispatchable` response field `siteId`; metrics (`realtime`/`community`/`my-evals`/`leaderboard`) response field `siteId`; job-poll `GET /api/eval-agent/jobs` takes **no** site query param; exact-site query param renamed `region`→`siteId` on `run-targets` and leaderboard filters.
- Produces (server-internal): `storage.isAllocatedSite(siteId: string, activeOnly = true): Promise<boolean>`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Ensure local Postgres is up (for the migration apply step later)**

Run: `./scripts/dev-local-run.sh status` — if not running: `./scripts/dev-local-run.sh start`.

- [ ] **Step 2: Write the migration SQL**

Create `migrations/0033_region_to_site_id.sql` verbatim:

```sql
-- Rename the overloaded `region` column (which stores a full sequenced site id
-- like na-us-seattle-02, not a region) to `site_id` across all nine tables that
-- carry it, and rename the two region-bearing indexes to match. RENAME COLUMN is
-- metadata-only and preserves all data — no backfill.
ALTER TABLE "eval_agent_tokens" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_agents" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_schedules" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_jobs" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "eval_results" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_events" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_runner_issued_tokens" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_runner_pool" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER TABLE "clash_schedules" RENAME COLUMN "region" TO "site_id";
--> statement-breakpoint
ALTER INDEX "eval_jobs_status_region_idx" RENAME TO "eval_jobs_status_site_idx";
--> statement-breakpoint
ALTER INDEX "eval_results_provider_region_idx" RENAME TO "eval_results_provider_site_idx";
```

- [ ] **Step 3: Register the migration as version 34**

In `server/migrate.ts`, append to the `MIGRATIONS` array (after the version 33 entry), matching the existing entry style:

```ts
{ version: 34, description: "rename region → site_id (9 tables + 2 indexes)", file: "0033_region_to_site_id.sql" },
```

- [ ] **Step 4: Rename the 9 columns in `shared/schema.ts`**

At each listed line, change the Drizzle column from `region: varchar("region", { length: 64 })…` to `siteId: varchar("site_id", { length: 64 })…` (preserve the exact modifiers — `.notNull()`, defaults, etc. — that already trail each definition). Lines: 209 (`eval_agent_tokens`), 233 (`eval_agents`), 271 (`eval_schedules`), 351 (`eval_jobs`), 399 (`eval_results`), 842 (`clash_events`), 965 (`clash_runner_issued_tokens`), 987 (`clash_runner_pool`), 1021 (`clash_schedules`).

- [ ] **Step 5: Rename the 2 index definitions in `shared/schema.ts` (name string AND `.on()` ref)**

At schema.ts:369:
```ts
// before: statusRegionIdx: index("eval_jobs_status_region_idx").on(table.status, table.region),
statusSiteIdx: index("eval_jobs_status_site_idx").on(table.status, table.siteId),
```
At schema.ts:429:
```ts
// before: providerRegionIdx: index("eval_results_provider_region_idx").on(table.providerId, table.region),
providerSiteIdx: index("eval_results_provider_site_idx").on(table.providerId, table.siteId),
```

- [ ] **Step 6: Check for insert/select Zod schemas that name `region` explicitly**

Run: `grep -n "region" shared/schema.ts | grep -Ei "omit|pick|extend|z\.string|z\.enum"`
`createInsertSchema`/`createSelectSchema` auto-derive `siteId` from the renamed column, so most need nothing. If any `.omit({...})` / `.pick({...})` / `.extend({...})` literally lists `region`, rename that key to `siteId`. (Do NOT touch `s3Region` or `region_locations` / `regionScope` occurrences.)

- [ ] **Step 7: Apply the migration to the local dev DB**

Run: `DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate`
Then verify the rename landed: `PGPASSWORD=vox123 psql -h localhost -U vox -d vox -c "\d eval_jobs" | grep site_id`
Expected: a `site_id` column row; no `region` column.

- [ ] **Step 8: Rename `isAllocatedRegion` → `isAllocatedSite` in `server/storage.ts`**

At storage.ts:478 rename the method and its parameter:
```ts
// before: async isAllocatedRegion(region: string, activeOnly = true): Promise<boolean> {
async isAllocatedSite(siteId: string, activeOnly = true): Promise<boolean> {
```
Update its body to use `siteId` (the `regionSiteSequence(...)` call at ~L475/481 takes the site-id string — pass `siteId`). The site-id allocator local variable in `createEvalAgentTokenForLocation` (~L503) that holds `` `${base_id}-${padded}` `` → rename to `siteId`. Leave `regionSiteSequence`'s own name (it lives in `shared/regions.ts`, out of this rename's scope).

- [ ] **Step 9: Update `server/storage.ts` callers and DTO field accesses**

Run: `npm run check 2>&1 | grep storage.ts` and fix every reported `.region`/`region:` on the nine renamed tables to `siteId`. This includes `buildJobSnapshot`, `createEvalJob`, dispatch/query helpers, and any object literals returned to routes. (The compiler flags each — do NOT hand-edit `s3Region`.)

- [ ] **Step 10: Rename the typed server references across routes/index (compiler-driven loop)**

Run `npm run check` repeatedly; each error is a stale typed `region`. Fix in:
- `server/routes.ts`: eval-agent register **response** field (L3159/3172) `region`→`siteId`; `/api/eval-agents` + `/dispatchable` response fields (L3031/3053/3065); metrics response fields `region: r.region`→`siteId: r.siteId` (L4439-4440, 4583, 4627-4628); schedule validate `storage.isAllocatedRegion(...)`→`storage.isAllocatedSite(...)` (L2131-2133).
- `server/routes-api-v1.ts`: dispatch endpoint request-body field (L300) and job write (L369) `region`→`siteId`; validation message (L339) "An exact region site ID is required" → "An exact site ID is required"; `apiRegionMetadata()` (L18-39) input param name→`siteId` (keep OUTPUT keys `regionLabel`/`regionBaseId`/`macroRegion*` — genuine region labels).
- `server/index.ts`: `processScheduledJobs` forwards `createEvalJob({ ..., siteId })`.

Repeat until `npm run check` is fully green.

- [ ] **Step 11: Rename the untyped query-param surfaces (not caught by the compiler)**

These are string query params — grep, don't trust the compiler:
Run: `grep -n "query\.region\|req\.query\[.region\|\.region\b" server/routes.ts server/routes-api-v1.ts`
- `parseRegionQueryScope` (routes.ts:123-207): the **exact-site-id** branch keyed `region` (L179-183) → read `siteId`; message → "siteId must be an exact allocated site ID". **Leave** the `location`/`country`/`macroRegion`/`regionScope` branches and the function name.
- `apiRegionScope()` (routes-api-v1.ts:43-92): exact-site branch (L82) keyed `region` → `siteId`; leave scope branches + function name.
- `run-targets` endpoint: read `siteId` from the query instead of `region`.
- Job-poll `GET /api/eval-agent/jobs`: **remove** the ignored `?region=` handling entirely (Core derives the site from the token, routes.ts:3251-3256).
- Leaderboard filter: the exact-site query param `region` → `siteId`.

- [ ] **Step 12: Update server/integration test fixtures**

In the listed test files, rename `region:`→`siteId:` on fixtures for the renamed columns/fields, and change job-poll fetches from `/api/eval-agent/jobs?region=<x>` to `/api/eval-agent/jobs` (param dropped):
- `tests/secrets-class-api.test.ts:233`, `tests/secrets.test.ts:574`, `tests/api.test.ts:1000` — drop `?region=` from the jobs fetch.
- `tests/session-dispatch.test.ts:493` — drop the `region=…&` query fragment.
- `tests/eval-jobs.test.ts`, `tests/job-recovery.test.ts`, `tests/clash-runner.test.ts`, `tests/clash-runner-lifecycle.test.ts` — `region:`→`siteId:` on any fixture object that targets a renamed column/field.
Run: `grep -rn "region" tests/eval-jobs.test.ts tests/job-recovery.test.ts tests/clash-runner.test.ts tests/clash-runner-lifecycle.test.ts` and convert only the site-id fixtures (leave `regionScope`/`location`/`macroRegion`/`s3Region`).

- [ ] **Step 13: Run type check + the touched test files**

Run: `npm run check`
Expected: PASS (zero errors).
Run: `npx vitest run tests/eval-jobs.test.ts tests/job-recovery.test.ts tests/clash-runner.test.ts tests/clash-runner-lifecycle.test.ts`
Expected: PASS.
Run: `npx vitest run tests/api.test.ts tests/secrets.test.ts tests/secrets-class-api.test.ts tests/session-dispatch.test.ts`
Expected: no NEW failures vs. the `main` baseline (the known caps + `:8099` daemon-health fails in api.test.ts may remain — confirm each pre-existing failure is unrelated to the rename).

- [ ] **Step 14: Commit**

```bash
git add migrations/0033_region_to_site_id.sql server/migrate.ts shared/schema.ts \
  server/storage.ts server/routes.ts server/routes-api-v1.ts server/index.ts \
  tests/api.test.ts tests/secrets.test.ts tests/secrets-class-api.test.ts \
  tests/session-dispatch.test.ts tests/eval-jobs.test.ts tests/job-recovery.test.ts \
  tests/clash-runner.test.ts tests/clash-runner-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
refactor(server): rename region → siteId across DB, schema, and server

The `region` column on nine tables stored a full sequenced site id
(na-us-seattle-02), not a region. Rename column + field + isAllocatedSite
helper to siteId; drop the ignored job-poll ?region= param; keep genuine
region-scope filters untouched. Hard cut, no wire alias.

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 2: Eval-agent daemon

Separate esbuild compile unit; runtime-coupled to Task 1's wire (register/job `siteId`, param-less job poll).

**Files:**
- Modify: `vox_eval_agentd/vox-agentd.ts:69,78,336,411,1819`
- Test: `tests/eval-agent-daemon.test.ts:352,363` (+ fixtures)

**Interfaces:**
- Consumes (from Task 1): register response `siteId`; job objects carry `siteId`; `GET /api/eval-agent/jobs` takes no site param.
- Produces: nothing downstream.

- [ ] **Step 1: Rename daemon interface fields**

In `vox_eval_agentd/vox-agentd.ts`: `EvalAgent.region` (L69) → `siteId`; `EvalJob.region` (L78) → `siteId`. **Do NOT touch** `S3Config.region` (L190, 207).

- [ ] **Step 2: Rename the register assignment and log lines**

- L336: `this.region = agent.region` → `this.siteId = agent.siteId` (and rename the class field declaration `this.region`/`private region` → `siteId`).
- L1819 and any other log line referencing `job.region` / `this.region` → `siteId`.
Run: `grep -n "\.region\b\|region:" vox_eval_agentd/vox-agentd.ts` and convert every non-S3 occurrence.

- [ ] **Step 3: Drop the `?region=` job-poll query**

At vox-agentd.ts:411, change the poll URL from `/api/eval-agent/jobs?region=${this.region}` (or `encodeURIComponent(...)`) to `/api/eval-agent/jobs` — no query param.

- [ ] **Step 4: Update daemon test fixtures**

In `tests/eval-agent-daemon.test.ts`: agent/job fixtures `region:`→`siteId:`; poll-URL expectations at L352/363 (`/api/eval-agent/jobs?region=na`, `?region=eu`) → `/api/eval-agent/jobs` (no param). Adjust any assertion that the daemon sent a region query.

- [ ] **Step 5: Type check + run daemon tests**

Run: `npm run check`
Expected: PASS.
Run: `npx vitest run tests/eval-agent-daemon.test.ts`
Expected: PASS (all 91).

- [ ] **Step 6: Commit**

```bash
git add vox_eval_agentd/vox-agentd.ts tests/eval-agent-daemon.test.ts
git commit -m "$(cat <<'EOF'
refactor(daemon): rename region → siteId; drop ignored job-poll param

Consume Core's siteId wire fields; poll /api/eval-agent/jobs with no site
query (Core derives it from the token). S3Config.region untouched.

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 3: Client (helpers, hooks, call sites, fixtures)

Separate Vite compile unit; consumes Task 1's `siteId` response fields. Contains the only genuinely new behavior (the three helpers) — write those TDD-first.

**Files:**
- Modify: `client/src/lib/utils.ts` (helpers + `REGIONS`→`SITES`)
- Modify: `client/src/hooks/use-regions.ts` (`useRegionOptions`→`useSiteOptions`)
- Modify: `client/src/components/region-scope-selector.tsx` and pages `realtime`, `run-your-own`, `clash-event`, `leaderboard`, `console-eval-agents`, `console-clash`, `clash`, `clash-detail`, `console-workflow-detail`, `console-organization-settings`, `console-eval-job-detail`, `console-eval-jobs`, `console-evalsets` (call sites)
- Test: `tests/regions.test.ts`, `tests/e2e/api.spec.ts:45-48`

**Interfaces:**
- Consumes (from Task 1): API responses now carry `siteId` (agents, jobs, metrics); `run-targets`/leaderboard filters take `siteId`.
- Produces: `regionOf(siteId: SiteId, locations?): Region`; `formatRegion(region: Region, locations?): string` (area only → "Seattle"); `formatSite(siteId: SiteId, locations?): string` (site label → "Seattle 02"); `useSiteOptions()`; `SITES`.

- [ ] **Step 1: Write failing helper tests in `tests/regions.test.ts`**

Add `formatSite` and `regionOf` to the existing import from client utils (alongside `formatRegion`), then add:

```ts
describe("site / region helpers", () => {
  it("regionOf strips the -NN sequence", () => {
    expect(regionOf("na-us-seattle-02")).toBe("na-us-seattle");
    expect(regionOf("apac-in-mumbai-01")).toBe("apac-in-mumbai");
  });
  it("regionOf returns the input unchanged when there is no sequence", () => {
    expect(regionOf("na-us-seattle")).toBe("na-us-seattle");
  });
  it("formatRegion shows the area only", () => {
    expect(formatRegion("apac-sg")).toBe("Singapore");
    expect(formatRegion("eu-de-frankfurt")).toBe("Frankfurt");
  });
  it("formatSite shows area + sequence", () => {
    expect(formatSite("apac-sg-01")).toBe("Singapore 01");
    expect(formatSite("eu-de-frankfurt-01")).toBe("Frankfurt 01");
  });
  it("compose: formatRegion(regionOf(siteId)) yields the area", () => {
    expect(formatRegion(regionOf("na-us-seattle-02"))).toBe("Seattle");
  });
});
```

Also update the existing site-label assertions (regions.test.ts:59-61) from `formatRegion("apac-sg-01")` etc. to `formatSite("apac-sg-01")` (they were always testing site labels).

> Note on `formatRegion("apac-sg")`: these use whatever default `region_locations` catalog the current `formatRegion` test setup relies on (the same cached catalog the existing tests use). If the existing tests pass an explicit `locations` array, pass the same array as the second arg here so the baseIds resolve.

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npx vitest run tests/regions.test.ts`
Expected: FAIL — `regionOf`/`formatSite` are not exported yet; `formatRegion("apac-sg")` returns the input (no area formatting yet).

- [ ] **Step 3: Rewrite the helpers in `client/src/lib/utils.ts`**

Rename the current `formatRegion` (utils.ts:63-81) to `formatSite`, **dropping** the dead legacy bare-macro branch (L65-71), and add `regionOf`, the new `formatRegion`, and the type aliases. Use the same cached-catalog pattern the current helper uses (`cachedRegionLocations` / whatever the existing default parameter is):

```ts
export type SiteId = string;   // "na-us-seattle-02"
export type Region = string;   // "na-us-seattle" (a region_locations.baseId)

// "na-us-seattle-02" -> "na-us-seattle": strip the trailing -NN sequence.
// Returns the input unchanged when it has no -NN sequence.
export function regionOf(siteId: SiteId, locations = cachedRegionLocations): Region {
  const normalized = siteId.toLowerCase();
  const match = [...locations]
    .sort((a, b) => b.baseId.length - a.baseId.length)
    .find((loc) => normalized.startsWith(loc.baseId + "-"));
  if (!match) return siteId;
  const sequence = normalized.slice(match.baseId.length + 1);
  return /^\d+$/.test(sequence) ? match.baseId : siteId;
}

// "na-us-seattle" -> "Seattle": region display name (area only, no sequence).
export function formatRegion(region: Region, locations = cachedRegionLocations): string {
  const match = locations.find((loc) => loc.baseId === region.toLowerCase());
  return match ? match.displayName : region;
}

// "na-us-seattle-02" -> "Seattle 02": site label (region display name + sequence).
// This is the former formatRegion, with the dead legacy bare-macro branch removed.
export function formatSite(siteId: SiteId, locations = cachedRegionLocations): string {
  const normalized = siteId.toLowerCase();
  const match = [...locations]
    .sort((a, b) => b.baseId.length - a.baseId.length)
    .find((loc) => normalized.startsWith(loc.baseId + "-"));
  if (!match) return siteId;
  const sequence = normalized.slice(match.baseId.length + 1);
  return /^\d+$/.test(sequence)
    ? `${match.displayName} ${sequence.padStart(2, "0")}`
    : siteId;
}
```

> Match the exact default-parameter name and `RegionLocation` shape the existing `formatRegion` used (`cachedRegionLocations` here is a placeholder for that existing binding — reuse it verbatim, do not introduce a new one). Leave the scope helpers (`resolveRegionScopeBaseIds`, `compressRegionScopeSelection`, `toggleRegionScopeSelection`, `formatRegionScopeSelection`, `appendRegionScopes`) and `cacheRegionLocations` unchanged.

- [ ] **Step 4: Rename the `REGIONS` fallback const → `SITES`**

In `client/src/lib/utils.ts`, rename the `REGIONS` const (holds site-ids) to `SITES`. (Consumer in `use-regions.ts` is updated in the next step.)

- [ ] **Step 5: Run helper tests to confirm they pass**

Run: `npx vitest run tests/regions.test.ts`
Expected: PASS.

- [ ] **Step 6: Rename the hook `useRegionOptions` → `useSiteOptions`**

In `client/src/hooks/use-regions.ts`: rename `useRegionOptions()` (L21) → `useSiteOptions()`; update the `REGIONS` import→`SITES` and the `[...REGIONS]` fallback→`[...SITES]` (L4, L24). **Leave** `useRegionLocationOptions()` (yields baseIds — genuinely region-level) and `useRegionLocations`/`cacheRegionLocations` unchanged.

- [ ] **Step 7: Update the 21 `formatRegion` call sites → `formatSite`**

Each currently passes a site-id and wants the "Seattle 02" label. Run: `grep -rn "formatRegion\b" client/src` and change every call that is NOT `formatRegionScopeSelection` from `formatRegion(...)`→`formatSite(...)`, updating the import in each file. Files: `components/region-scope-selector.tsx`, `pages/realtime.tsx`, `pages/run-your-own.tsx`, `pages/clash-event.tsx`, `pages/leaderboard.tsx`, `pages/console-eval-agents.tsx`, `pages/console-clash.tsx`, `pages/clash.tsx`, `pages/clash-detail.tsx`, `pages/console-workflow-detail.tsx`, `pages/console-organization-settings.tsx`, `pages/console-eval-job-detail.tsx`, `pages/console-eval-jobs.tsx`.

- [ ] **Step 8: Update `useRegionOptions` importers → `useSiteOptions`**

Run: `grep -rn "useRegionOptions" client/src` and rename each import + call in: `pages/run-your-own.tsx`, `pages/console-evalsets.tsx`, `pages/console-workflow-detail.tsx`, `pages/console-clash.tsx`, `pages/console-eval-jobs.tsx` (and any others the grep surfaces). Local variable names like `regionOptions` may stay; only the imported symbol must change.

- [ ] **Step 9: Update client API field reads `.region` → `.siteId` and the `run-targets` query param**

- Local API response types/interfaces in client pages that carry the renamed field: `region`→`siteId` (agents list, jobs list/detail, metrics rows). Run: `grep -rn "\.region\b\|region:" client/src | grep -iv "regionScope\|macroRegion\|s3Region\|formatRegionScope\|useRegionLocation"` and convert the site-id reads.
- `run-your-own.tsx:181` and `console-workflow-detail.tsx:87`: change `run-targets?region=${encodeURIComponent(region)}` → `run-targets?siteId=${encodeURIComponent(region)}` (only the query key changes; the local variable can keep its name).

- [ ] **Step 10: Drop the legacy-branch assertions in `tests/regions.test.ts`**

Remove the legacy bare-macro assertions (regions.test.ts:165-173) along with any comment tying them to the dropped `formatRegion` branch. **Keep** the migration-0023 rewrite assertions (they test the SQL, not the helper).

- [ ] **Step 11: Update the e2e leaderboard query**

In `tests/e2e/api.spec.ts:45-48`, change `/api/v1/metrics/leaderboard?region=na` → `/api/v1/metrics/leaderboard?siteId=<valid-allocated-site-id>` (or drop the filter and assert the unfiltered leaderboard shape). Update the test title/description accordingly. Use a site-id that exists in the e2e seed (e.g. the seeded mainline site); if none is guaranteed, assert the unfiltered response.

- [ ] **Step 12: Type check + client tests**

Run: `npm run check`
Expected: PASS.
Run: `npx vitest run tests/regions.test.ts`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add client/src/lib/utils.ts client/src/hooks/use-regions.ts client/src/components/region-scope-selector.tsx \
  client/src/pages tests/regions.test.ts tests/e2e/api.spec.ts
git commit -m "$(cat <<'EOF'
refactor(client): split formatRegion/formatSite; consume siteId fields

formatRegion now formats a region ("Seattle"); the old site-label behavior
("Seattle 02") moves to formatSite; add regionOf(). Rename useRegionOptions
-> useSiteOptions, REGIONS -> SITES, and read siteId from API responses.

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 4: OpenAPI doc

No compile; pure documentation. Lowest risk, done last.

**Files:**
- Modify: `docs/openapi.yaml:99,289,327,350,466,501,1364,1369,1393,1432-1437,1456`

**Interfaces:**
- Consumes: the wire shape produced by Task 1 (fields now named `siteId`; exact-site query param `siteId`).
- Produces: nothing (doc only).

- [ ] **Step 1: Rename the site-id `region` fields → `siteId`**

In `docs/openapi.yaml`, rename the request/response/schema `region` fields that carry an exact site id at L99, L289, L327, L350, L466, L501, L1369, L1393, L1456, and in the required-field list at L1364. Run: `grep -n "region" docs/openapi.yaml` and convert only site-id fields — **leave** `location`/`country`/`macroRegion`/`regionScope` scope query params.

- [ ] **Step 2: Rename the leaderboard filter query param and drop the stale enum**

At L1432-1437 rename the leaderboard filter query param `region`→`siteId`, and **delete** the stale `enum: [na, apac, eu, sa]` (~L1436) — the value is an exact allocated site id, not a bare macro. Describe it as a free-form string: "An exact allocated site id, e.g. `na-us-seattle-02`."

- [ ] **Step 3: Validate the OpenAPI doc parses**

Run: `npx --yes @redocly/cli lint docs/openapi.yaml || node -e "require('js-yaml').load(require('fs').readFileSync('docs/openapi.yaml','utf8')); console.log('yaml ok')"`
Expected: parses without a syntax error (lint warnings unrelated to this change are acceptable).

- [ ] **Step 4: Commit**

```bash
git add docs/openapi.yaml
git commit -m "$(cat <<'EOF'
docs(openapi): rename site-id region fields to siteId; drop stale enum

The exact-site fields are site ids; rename to siteId and remove the
pre-0023 enum [na, apac, eu, sa] that no longer exists in data.

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

## Final Verification (before branch finish)

- [ ] **Step 1: Full type check**

Run: `npm run check` — Expected: PASS.

- [ ] **Step 2: Grep for stray site-level `region` survivors**

Run:
```bash
grep -rn "\bregion\b" server shared vox_eval_agentd client/src docs/openapi.yaml \
  | grep -iv "regionScope\|macroRegion\|s3Region\|region_locations\|regionLocation\|regionSiteSequence\|formatRegionScope\|useRegionLocation\|region display\|the region\|real region\|apiRegionScope\|apiRegionMetadata\|parseRegionQueryScope\|resolveRegionScope\|compressRegionScope\|toggleRegionScope\|appendRegionScope"
```
Review each remaining hit: it must be a genuine region-level use (the new `formatRegion(region)`, `regionOf`'s return, region-scope machinery, region display names) — NOT a leftover site-id field. Fix any site-id leftover.

- [ ] **Step 3: Full suite**

Run: `./scripts/full-tests-run.sh`
Expected: no NEW failures vs. the `main` baseline (per Global Constraints). Investigate any failure that touches renamed code by construction before attributing it to baseline drift.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch. Do NOT merge to `main` until the user explicitly marks it. Deploy note for the user: this is a hard cut — Core and all daemon images must ship together (`scripts/vox-upgrade.sh`); an un-upgraded daemon breaks until its image is bumped.

---

## Self-Review

**Spec coverage** (design §Design by layer → task):
- Layer 1 (DB migration + schema): Task 1 steps 2-7. ✓ (9 columns, 2 indexes, version 34, hand-written rename, insert-schema check.)
- Layer 2 (server): Task 1 steps 8-12. ✓ (storage `isAllocatedSite` + allocator, routes register/eval-agents/metrics/scope/schedule, routes-api-v1 dispatch/apiRegionScope/apiRegionMetadata, index scheduler, untyped query params.)
- Layer 3 (daemon): Task 2. ✓ (interfaces, this.siteId, drop `?region=`, logs, S3 untouched.)
- Layer 4 (client): Task 3. ✓ (formatRegion/formatSite/regionOf, types, REGIONS→SITES, useSiteOptions, 21 call sites, API `.region`→`.siteId`.)
- Layer 5 (OpenAPI): Task 4. ✓ (site-id fields, stale enum, scope params left.)
- Layer 6 (tests): folded — regions.test.ts (Task 3 steps 1-2,10), fixtures (Task 1 step 12, Task 2 step 4), new helper coverage (Task 3 step 1). ✓
- Non-goals preserved (scope filters, S3 region, snapshot keys): asserted in Global Constraints and re-checked in Final Verification step 2. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one soft spot — `cachedRegionLocations` as the default-parameter binding — is explicitly flagged as "reuse the existing binding verbatim" because the exact identifier depends on current utils.ts (do not invent a new one). All migration SQL, index defs, and helper bodies are literal.

**Type consistency:** `siteId` (field), `SiteId`/`Region` (aliases), `isAllocatedSite`, `useSiteOptions`, `SITES`, `regionOf`/`formatRegion`/`formatSite` used identically across tasks. Task 1 "Produces" wire fields match Task 2/3 "Consumes". `formatRegion` is deliberately repurposed (not removed) — flagged in every task that touches it.
