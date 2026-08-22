# `region` → `siteId` Terminology Refactor — Design

**Date:** 2026-08-22
**Status:** Approved for planning
**Author:** brainstormed with Brent G

## Problem

The word **`region`** is overloaded. A column literally named `region` — on nine
tables — stores a **full, sequenced site identifier** like `na-us-seattle-02`.
That value is not a region; it is a specific agent *site* (a region plus a
sequence number identifying which slot in that place). The genuine region is
`na-us-seattle` ("Seattle"). The same overload runs through the wire protocol,
the public API, the OpenAPI doc, and the client display helpers, where
`formatRegion("na-us-seattle-02")` returns `"Seattle 02"` — formatting a "region"
that is actually a site.

This refactor reserves **`region`** for the real region and renames the
sequenced identifier everything actually stores to **`siteId`**.

## Vocabulary (the naming contract)

```
na  -  us  -  seattle  -  02
│      │      │           └─ sequence   (which agent slot in that place)
│      │      └─ area/place  (Seattle)
│      └─ country  (US)
└─ macro / geo  (North America)
```

| Value | Meaning | Name after this refactor |
|---|---|---|
| `na-us-seattle-02` | a specific agent **site** (region + sequence) | **`siteId`** |
| `na-us-seattle` | the **region** (a `region_locations.baseId`) | **`region`** |
| `Seattle` | region display name | region display name |
| `na` → North America | macro region / geo | macro region / geo (unchanged) |

**Region-*scope* filters** (`macro:`, `country:`, `location:`, `regionScope`,
`location`, `country`, `macroRegion` query params) are genuinely region-level
and are **already correctly named**. They are **not** touched.

### Helper API (client, `client/src/lib/utils.ts`)

```ts
type SiteId = string;   // "na-us-seattle-02"
type Region = string;   // "na-us-seattle"  (a region_locations.baseId)

regionOf(siteId: SiteId): Region        // "na-us-seattle-02" → "na-us-seattle"  (strip -NN)
formatSite(siteId: SiteId): string      // "na-us-seattle-02" → "Seattle 02"     (today's formatRegion, renamed)
formatRegion(region: Region): string    // "na-us-seattle"    → "Seattle"        (NEW; what tier-targeting needs)
```

`formatRegion` **keeps its name but its meaning becomes honest**: it now formats a
*region* → `"Seattle"`. Today's site-label behavior (`"Seattle 02"`) moves to
**`formatSite`**. To show just the area from a site-id, compose:
`formatRegion(regionOf(siteId))`.

`SiteId` and `Region` are documentation type-aliases (`type X = string`) — they
add no runtime behavior, only reader clarity at signatures.

## Non-goals

- **Tier-targeting** (agent tier targeting + plugin-gated tiers). It rides on top
  of this refactor as a separate spec, on the clean vocabulary.
- **The region-scope model** (`regionScope`/`location`/`country`/`macroRegion`).
  Genuinely region-level; unchanged.
- **AWS S3 region** — `userStorageConfig.s3Region` (schema.ts:447) and the
  daemon's `S3Config.region` (vox-agentd.ts:190,207, from `S3_REGION`). Unrelated
  concept; unchanged.
- **Historical `snapshot` jsonb keys** — frozen provenance on existing rows; left
  as-is. (The job's region is a top-level column, renamed below; the immutable
  snapshot does not carry a separate region key to migrate.)

## Grounding facts (from audit)

- Every runtime write to these columns is a full `<base>-<sequence>` site-id.
  Site-ids are minted in exactly one place: `server/storage.ts:503`,
  `createEvalAgentTokenForLocation()`, under a `FOR UPDATE` lock on
  `region_locations`, then `next_sequence` is incremented.
- `shared/regions.ts:regionSiteSequence()` strictly requires a `-NN`
  zero-padded numeric suffix. `storage.isAllocatedRegion()` requires an exact
  allocated site-id.
- Bare macro values (`na`, `apac`, …) existed only pre-migration `0023`, which
  rewrote all nine columns to full site-ids and `RAISES EXCEPTION` on any
  remaining bare value. **Therefore `regionOf(siteId)` need not tolerate legacy
  bare values for production data**, and the `formatRegion` legacy branch
  (utils.ts:65–71) is dead — it is dropped in this pass.
- The daemon's job-poll `?region=` query param (vox-agentd.ts:411) is **already
  ignored** by Core, which derives the site from the token
  (routes.ts:3251–3256). It is dropped.

## Design by layer

Each layer is an independently testable unit. Order below is the dependency
order for implementation.

### Layer 1 — Database migration

**File:** `migrations/0033_region_to_site_id.sql`, registered as **version 34**
in `server/migrate.ts` (latest registered is version 33 / `0032_*`).

Plain `ALTER TABLE ... RENAME COLUMN region TO site_id` for all nine columns.
Column rename preserves data — no backfill.

| # | Table | Column | schema.ts line |
|---|---|---|---|
| 1 | `eval_agent_tokens` | `region` → `site_id` | 209 |
| 2 | `eval_agents` | `region` → `site_id` | 233 |
| 3 | `eval_schedules` | `region` → `site_id` | 271 |
| 4 | `eval_jobs` | `region` → `site_id` | 351 |
| 5 | `eval_results` | `region` → `site_id` | 399 |
| 6 | `clash_events` | `region` → `site_id` | 842 |
| 7 | `clash_runner_issued_tokens` | `region` → `site_id` | 965 |
| 8 | `clash_runner_pool` | `region` → `site_id` | 987 |
| 9 | `clash_schedules` | `region` → `site_id` | 1021 |

Rename the region-bearing indexes in the same file so index names stay honest:
- `eval_jobs_status_region_idx` → `eval_jobs_status_site_idx` (schema.ts:369)
- the `eval_results` region index (schema.ts:429) → `..._site_idx`

SQL stays plain (no `IF NOT EXISTS`, no `DO`/exception blocks) per project rule;
the migration runs exactly once on a DB that lacks it.

**`shared/schema.ts`:** each renamed column's Drizzle definition becomes
`siteId: varchar("site_id", { length: 64 })...`. The two index definitions must
change on **both** sides — the index-name string **and** the `.on(...)` column
reference: e.g. `index("eval_jobs_status_region_idx").on(table.status,
table.region)` → `index("eval_jobs_status_site_idx").on(table.status,
table.siteId)` (schema.ts:369), and likewise for the `eval_results` region index
(schema.ts:429) — kept identical to the migration's `ALTER INDEX ... RENAME`.
Regenerate/adjust the affected insert/select Zod schemas so `siteId` is the field
name. `region_locations` and `s3Region` are untouched.

### Layer 2 — Server (storage, routes, dispatch)

- `server/storage.ts`: the site-id allocator local variable and every query/DTO
  touching the renamed columns use `siteId`. `createEvalAgentTokenForLocation`
  still mints `${base_id}-${padded_sequence}`; only the field name changes.
  `isAllocatedRegion()` operates on a site-id — rename to `isAllocatedSite()`
  (it validates an exact allocated site-id).
- `server/routes.ts`:
  - Eval-agent register **response** field `region` → `siteId`
    (routes.ts:3159/3172).
  - Job-poll: **remove** the ignored `?region=` handling (routes.ts:3236 area);
    each returned job carries `siteId` instead of `region`.
  - `/api/eval-agents` and `/api/eval-agents/dispatchable` **response** field
    `region` → `siteId` (routes.ts:3031, 3053, 3065).
  - `parseRegionQueryScope` (routes.ts:123–207): the **exact-site-id filter**
    branch currently keyed `region` (routes.ts:179–183) becomes `siteId`
    ("siteId must be an exact allocated site ID"). The `location`/`country`/
    `macroRegion`/`regionScope` branches are unchanged.
  - Metrics responses (`realtime`, `leaderboard`) field `region: r.region` →
    `siteId` (routes.ts:4439–4440, 4583, 4627–4628). `regionMetadata()` stays
    (it derives region-level labels from a site-id) but its input param is a
    site-id — name it accordingly.
  - Schedule create/validate: `isAllocatedRegion` call at routes.ts:2131–2133 →
    `isAllocatedSite`; the schedule's stored field is `siteId`.
- `server/routes-api-v1.ts`:
  - Dispatch/run endpoint (L300–369): request **body** field `region` → `siteId`;
    validation message "An exact region site ID is required" →
    "An exact site ID is required"; job written with `siteId: requestedSiteId`.
  - `apiRegionScope()` (L43–92): exact-site-id branch (L82) keyed `region` →
    `siteId`; scope branches unchanged.
  - `apiRegionMetadata()` (L18–39): input is a site-id; keep the
    `regionLabel`/`regionBaseId`/`macroRegion*` **output** keys (they are
    genuine region-level labels), only the input param name changes.
- `server/index.ts` scheduler (`processScheduledJobs`): forwards the schedule's
  `siteId` into `createEvalJob({ ... siteId })`.

### Layer 3 — Eval-agent daemon (`vox_eval_agentd/vox-agentd.ts`)

Hard cut, coordinated deploy — no backward-compat alias.

- `EvalAgent.region` (L69) → `siteId`; `EvalJob.region` (L78) → `siteId`.
- Register: `this.siteId = agent.siteId` (was `this.region = agent.region`, L336).
- Job poll: drop the `?region=${this.region}` query (L411) — poll
  `GET /api/eval-agent/jobs` with no site param (Core derives it from the token).
- Any log line referencing `job.region` / `this.region` (e.g. L1819) → `siteId`.
- The daemon's AWS `S3Config.region` (L190, 207) is **unchanged**.

Deployment: ship Core and push new daemon images together via
`scripts/vox-upgrade.sh`. An un-upgraded daemon breaks until its image is bumped;
this is accepted (hard cut).

### Layer 4 — Client (`client/src/`)

- `lib/utils.ts`:
  - Rename current `formatRegion` → **`formatSite`** (unchanged behavior:
    site-id → `"Seattle 02"`); drop the dead legacy bare-macro branch.
  - Add **`regionOf(siteId): Region`** (strip the `-NN` sequence → baseId).
  - Add **`formatRegion(region): string`** (baseId → `"Seattle"`), using the
    cached `region_locations` catalog.
  - Add `type SiteId` / `type Region` aliases.
  - Rename the `REGIONS` fallback const (holds site-ids) → **`SITES`**.
  - Scope helpers (`resolveRegionScopeBaseIds`, `compressRegionScopeSelection`,
    `toggleRegionScopeSelection`, `formatRegionScopeSelection`,
    `appendRegionScopes`) are scope-level → **unchanged**.
- `hooks/use-regions.ts`: `useRegionOptions()` (yields site-ids) →
  **`useSiteOptions()`**; `useRegionLocationOptions()` (yields baseIds) stays
  region-level and keeps its name. `useRegionLocations`/`cacheRegionLocations`
  (area catalog) unchanged.
- Update the **21 `formatRegion` call sites across 13 files** (region-scope-selector
  and pages: realtime, run-your-own, clash-event, leaderboard, console-eval-agents,
  console-clash, clash, clash-detail, console-workflow-detail,
  console-organization-settings, console-eval-job-detail, console-eval-jobs) —
  each currently passes a site-id and wants `"Seattle 02"`, so each becomes
  `formatSite(...)`. Any client type/field carrying the API's renamed `region`
  response becomes `siteId`.

### Layer 5 — OpenAPI (`docs/openapi.yaml`)

- Rename the site-id request/response `region` fields to `siteId`
  (response/schema fields at L99, L289, L327, L350, L466, L501, L1369, L1393,
  L1456; required-field list at L1364; leaderboard request query at L1432–1437).
- **Fix the stale `enum: [na, apac, eu, sa]`** at ~L1436 — it encodes the
  pre-0023 bare-macro world that no longer exists in data. The value is an exact
  allocated site-id; drop the enum (free-form string, described as an exact site
  id) to match runtime validation.
- Leave scope query params (`location`/`country`/`macroRegion`/`regionScope`)
  as-is.

### Layer 6 — Tests

- `tests/regions.test.ts`: drop the legacy bare-branch assertions
  (L165–173) along with the branch; keep/adjust the migration-0023 rewrite
  assertions (they test the SQL, not the helper).
- Fixtures across `tests/` (`clash-runner`, `job-recovery`, `eval-jobs`,
  `eval-agent-daemon`, `api.test.ts`, e2e specs) that pass `region:` for a
  renamed column/field/helper become `siteId:`; simplified bare `region:"na"`
  fixtures become valid site-ids where the code now validates them.
- Add unit coverage for the new helpers: `regionOf`, `formatRegion(region)`,
  and `formatSite` (rename of existing coverage).

## Rollout / risk

- **Single coordinated deploy.** Migration renames columns (fast, metadata-only);
  Core and daemon images ship together. Order within the deploy: DB migration
  runs on Core startup (via `server/migrate.ts`), Core serves the new field
  names, daemons upgraded in the same window.
- **Blast radius is wide but mechanical.** ~870 identifier hits, but the
  semantic decisions are all made here; implementation is rename + adjust +
  test per layer. Each layer compiles and tests independently.
- **`npm run check` + full test suite** gate the branch; `./scripts/full-tests-run.sh`
  before merge.

## Open questions

None. All naming, column-set, wire-compat, and helper decisions are resolved
above.
