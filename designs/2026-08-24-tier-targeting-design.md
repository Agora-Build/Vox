# Tier-Targeting — Region-Pooled Dispatch by Agent Tier — Design

**Date:** 2026-08-24
**Status:** Approved in chat (sectioned review); pending written-spec review
**Author:** brainstormed with Brent G

## 1. Problem

Dispatch today has exactly two modes: **targeted** (`targetTokenId` → one specific
agent token, tier-authorized at dispatch) and **untargeted** (an exact-site pool
claimable only by `public`-tier agents or the dispatcher's own). There is no way
to say "any of MY agents", "any of my TEAM's agents", or "any public agent in
Seattle" — the pool is site-pinned (`na-us-seattle-01`) when the real intent is a
region ("Seattle"), and the public pool silently mixes in the dispatcher's own
agents.

This cycle delivers **free-tier pooled dispatch**: a job targets a **region ×
tier** pool, and any qualified agent in that region claims it. It rides on the
completed `region → siteId` refactor (clean vocabulary: `region` =
`na-us-seattle`, `siteId` = `na-us-seattle-02`) and on tier-unification
(`dispatchTier` `private|team|public|shared` as the sole agent classifier).

**Explicitly out of scope (user decision, 2026-08-24):**
- **Pooled `shared` (paid) dispatch** — shelved. The schema leaves it a drop-in
  slot (§10). The product vision for it (complexity-tier pricing + capability
  premiums, price-cap escrow for pooled claims, host-fail = no charge,
  task-fail = 1 free retry/72h) is recorded for that future cycle.
- Trust-graded / network-instinct agent labeling.
- Any change to targeted (`targetTokenId`) authorization rules.

## 2. Decisions (locked in chat)

1. **Scope:** `targetTier` for free tiers (`private`/`team`/`public`) +
   region-level pooling + selector UX with plugin gating. Shared pooling
   deferred.
2. **Schedules included:** eval-schedules gain the same region + tier targeting.
3. **Explicit tier, always:** every new dispatch carries a `targetTier`; the UI
   preselects `public`. The legacy mixed "public OR mine" pool survives only for
   in-flight rows (`targetTier IS NULL`) until they drain.
4. **Region-only pools:** exact-site untargeted dispatch is removed (no
   back-compat, consistent with the alias drops). Precision = `targetTokenId`.
5. **Pools are queues (no fast-fail):** an empty pool is a normal transient
   state. Pooled jobs wait for an eligible agent; only the existing 24h pending
   backstop bounds them. Targeted jobs keep the 15-minute fast-fail.

## 3. Vocabulary

```
region   = na-us-seattle      (region_locations.baseId; what a pool targets)
siteId   = na-us-seattle-02   (concrete agent site; stamped at claim)
tier     = private | team | public | shared   (dispatch_tier enum, reused)
```

Client helpers already exist: `regionOf(siteId)`, `formatRegion(region)` →
`"Seattle"`, `formatSite(siteId)` → `"Seattle 02"`.

## 4. Data model & migration

One migration: `migrations/0034_tier_targeting.sql`, registered as **version 35**
in `server/migrate.ts` `MIGRATIONS`. Plain statements, no `IF NOT EXISTS`.
Reuses the existing `dispatch_tier` pg enum — no new enum type.

### `eval_agent_tokens`
- **Add** `region varchar(64) NOT NULL` — the region baseId, stamped at mint
  (`createEvalAgentTokenForLocation` already holds the `region_locations` row
  when it allocates the site sequence).
- **Backfill:** `region = regexp_replace(site_id, '-[0-9]+$', '')`.
- Index on `(region)` (used by the pooled-claim join).

### `eval_jobs`
- `site_id` → **DROP NOT NULL** (a pooled job is born site-less; the claim
  stamps it).
- **Add** `target_region varchar(64)` (nullable).
- **Add** `target_tier dispatch_tier` (nullable). `'shared'` is a **reserved
  value**: the enum admits it, the run route rejects it this cycle.
- **Row invariant (new rows):** exactly one of
  `target_token_id IS NOT NULL` (targeted — `site_id` is still stamped at
  dispatch from the token, exactly as today) **or**
  `target_region IS NOT NULL AND target_tier IS NOT NULL` (pooled — born
  site-less, `site_id` stamped at claim). Legacy rows: `site_id` set,
  `target_token_id`, `target_region`, `target_tier` all null.
- Partial index on `(target_region, target_tier)` `WHERE status = 'pending'`
  (claim-scan path).

### `eval_schedules`
- **Add** `region varchar(64) NOT NULL` — backfill
  `regexp_replace(site_id, '-[0-9]+$', '')`.
- **Add** `target_tier dispatch_tier NOT NULL DEFAULT 'public'` — backfill
  `'public'`.
- **DROP** `site_id`. (Known semantic note: old schedules implicitly allowed
  the owner's own agents via the mixed pool; backfilled `public` drops that arm.
  An owner who relied on a private agent serving their schedule re-picks
  "My agents" once in the UI.)

`snapshot` jsonb is untouched (frozen provenance). `evalResults.siteId` is
untouched — it copies from the job at completion, and claim stamps the site
before anything runs.

## 5. Dispatch API

### `POST /api/workflows/:workflowId/run`
Body accepts **exactly one** targeting form (400 otherwise):
- `{ targetTokenId, evalSetId }` — unchanged precision path; tier authz at
  dispatch as today (private=owner, team=`sameOrg`, public=anyone,
  shared=marketplace escrow).
- `{ region, targetTier, evalSetId }` — pooled path:
  - `region` must be an active `region_locations.baseId` (400 otherwise).
  - `targetTier` authz: `private` → always (it is the dispatcher's own pool);
    `team` → `hasOrg(user)` (400 "join an organization to use team agents"
    otherwise); `public` → anyone; `shared` → 400 "pooled shared dispatch is
    not available".
  - **Session-injection composition:** when `workflowNeedsSession()` detects a
    login-class secret (the run route already stamps `sessionInjection`), the
    pooled form is restricted to `targetTier` `private` or `team` — `public`
    is rejected 403 (the session serve gate admits owner + team agents only;
    a public-pool claim would take the job and then be refused the session).
    Belt-and-braces: the pooled `public` claim arm also excludes
    session-injected jobs (§6), mirroring today's untargeted rule.
  - Job row: `site_id = NULL`, `target_region`, `target_tier`,
    `target_token_id = NULL`.

The exact-site body key (`siteId`) is **removed** from the run route.

### `POST /api/eval-schedules` (and schedule edit)
- Body takes `{ region, targetTier }` instead of `siteId`; same validation and
  tier authz as the run route (evaluated against the schedule creator).
  Schedules remain pool-only (no `targetTokenId`), as today.
- The scheduler loop stamps `target_region = schedule.region`,
  `target_tier = schedule.targetTier`, `site_id = NULL` onto each job it
  creates. The scheduler's existing per-tick authorization re-check
  (`canScheduleWorkflow`) is unchanged; a `team` schedule whose creator left
  the org simply stops matching any agent and rides the pending backstop —
  no new scheduler logic.

## 6. Claim predicate (permissions ↔ storage SQL, mirrored bit-for-bit)

`server/permissions.ts` `isClaimable(job, token, owners)` — for token `T`,
pending job `J` in the same evaluation:

The three arms are **mutually exclusive by job shape** — a targeted job
(`targetTokenId` set) matches ONLY its aimed token, never a pool or legacy arm:

- **targeted** (`J.targetTokenId IS NOT NULL`): claimable iff
  `J.targetTokenId == T.id`.
- **pooled** (`J.targetRegion IS NOT NULL`): claimable iff
  `T.region == J.targetRegion` AND the tier arm expresses **mutual consent**
  (the dispatcher's requested pool ∩ the owner's offered `dispatchTier`):
  - `J.targetTier == 'private'` → `T.createdBy == J.createdBy` (any tier of
    the dispatcher's OWN tokens — owner consent is trivially the dispatcher's).
  - `J.targetTier == 'team'`    → `sameOrg(T.owner, J.creator)` **AND**
    `T.dispatchTier IN ('team', 'public')` — an org-mate's `private` token is
    excluded: its owner offered it to nobody else, and the targeted path
    (`canDispatchToToken`) already forbids team dispatch to a private token.
    (The creator's own private tokens serve their jobs via the private pool.)
  - `J.targetTier == 'public'`  → `T.dispatchTier == 'public'` AND the job is
    not session-injected (`config -> 'sessionInjection' IS NULL`, exactly the
    guard today's untargeted arm applies).
- **legacy** (`J.targetTokenId IS NULL AND J.targetRegion IS NULL`, until
  drained): claimable iff `J.siteId == T.siteId` AND
  (`T.dispatchTier == 'public'` OR `T.createdBy == J.createdBy`).

`server/storage.ts` `getClaimableJobsForToken` / `claimEvalJob` implement the
same predicate in SQL (team arm = join `users` on both sides,
`u1.organization_id IS NOT NULL AND u1.organization_id = u2.organization_id`).
Claim remains a single atomic `SELECT … FOR UPDATE SKIP LOCKED`; the claiming
`UPDATE` additionally sets `site_id = T.siteId`.

The framework-version jobs-listing gate (only-narrows) is unchanged and composes
with the new predicate.

## 7. Lifecycle & reapers

- **Targeted jobs:** keep the existing 15-minute no-agent fast-fail (the aimed
  agent being down is actionable and no other agent can ever serve the job).
- **Pooled jobs:** **no fast-fail.** A pool is a queue: the job stays `pending`
  through agent churn and is bounded only by the existing 24h
  `PENDING_MAX_WAIT_MINUTES` backstop. Failure reason names the pool:
  `"no eligible <tier> agent in <region> claimed the job within 24h"`. No new
  reaper, no new tunable (YAGNI until real usage demands one).
- **Site-pinned rows (targeted + legacy):** the fast-fail query applies only
  `WHERE site_id IS NOT NULL AND target_region IS NULL` plus, for targeted
  rows, the aimed token's agent — pooled rows are excluded by shape.
- Running-job hard cap (90min), stale-claim release, and completion flow
  unchanged. A never-claimed failed job keeps `site_id NULL` — correct, it ran
  nowhere.

## 8. Targeting surface & plugin gating

`GET /api/workflows/:id/run-targets?region=<baseId>&evalSetId=` gains a
server-computed `tiers` block (same never-offer-a-403 philosophy as
`canSchedule`/`canManage`):

```jsonc
{
  "agents": { "mine": [...], "shared": [...] },   // unchanged: the targetTokenId path
  "referencedSecrets": [...],                      // unchanged
  "tiers": [
    { "tier": "private", "available": true,  "onlineAgents": 2 },
    { "tier": "team",    "available": false, "reason": "no-org" },
    { "tier": "public",  "available": true,  "onlineAgents": 5 },
    { "tier": "shared",  "available": false, "reason": "not-pooled-yet" }
  ]
}
```

- `onlineAgents` = count of online agents matching (chosen region × tier ×
  this dispatcher) — i.e. the claim predicate evaluated against live agents.
- `team.available` gates on `hasOrg(user)`; `shared.available` is `false` this
  cycle (reserved). The existing `agents.shared` listings remain
  plugin-gated (present only when `vox.eval-marketplace` is loaded) — that is
  the plugin-gating story for this cycle.
- The run-targets query param changes `?siteId=` → `?region=` (site filtering
  no longer meaningful for pools; `agents.mine`/`agents.shared` filter by
  region).
- `GET /api/eval-agents/dispatchable`: `free` rows gain `region` alongside
  `siteId`; shape otherwise unchanged.

## 9. Client UX

All four dispatch surfaces (run-your-own, console-workflow-detail run dialog,
console-evalsets run/schedule dialogs, schedules) converge on one selector:

- **Region** — `useRegionLocationOptions` (baseId values, labels like
  `"Seattle, United States · North America"` via `formatRegion`). Replaces the
  site picker everywhere.
- **Run on** — tier choice, default **Any public agent**; *My agents*
  (`private`), *Team agents* (`team`, hidden/disabled with reason when
  `tiers.team.available` is false), and the specific-agent dropdown
  (`agents.mine` + `agents.shared`) which switches the request to
  `targetTokenId`.
- **Empty-pool notice:** when the chosen pool's `onlineAgents` is 0, submission
  proceeds but the dialog shows: "no matching agent is online right now; the
  job will wait in the pool (up to 24h)". Informed queueing, not refusal.
- **Display:** pending pooled job → `formatRegion(targetRegion)` + tier badge
  ("Seattle · public pool"); after claim → `formatSite(siteId)` ("Seattle 02").
  Schedules show region + tier.

## 10. The shared slot (future cycle, shaped now)

`target_tier` already admits `'shared'`; `target_region` already exists. The
future paid-pooling cycle adds only:
- a marketplace seam extension: authorize-pooled-dispatch with a **price cap**
  (escrow holds the cap; settle at the claimer's listing price ≤ cap),
- settlement rules from the recorded product vision: complexity-tier base
  pricing + capability premiums; **host failures** (crash/connectivity/system
  fault) → no charge; **task/target failures** (agent fine, target broke) →
  1 free manual retry within 72h.

No schema rework will be needed.

## 11. Metrics & tier classification

Unchanged by construction. Classification reads `tokenDispatchTier` frozen at
claim; pooled jobs are still claimed by a concrete token, so a public-pool job
claimed by a public token stays Mainline-eligible (when the other mainline
conditions hold), and private/team pool jobs land in My Evals/Community per
their claiming token. `evalResults.siteId` attribution works because claim
stamps the site before execution.

## 12. Testing

- **Predicate matrix (unit):** `isClaimable` over targeted × pooled × legacy ×
  each tier × region match/mismatch × org membership variants × the token's
  own `dispatchTier` (mutual-consent cases: an org-mate's `private` token must
  NOT claim a `team`-pool job; an org-mate's `team` or `public` token must; the
  dispatcher's own token of any tier claims their `private`-pool job).
- **SQL mirror (integration):** `getClaimableJobsForToken`/`claimEvalJob` agree
  with the predicate bit-for-bit; claim stamps `site_id`; `SKIP LOCKED`
  atomicity unchanged.
- **Migration:** token `region` backfill strips `-NN` correctly (incl. bases
  whose own segments contain digits); schedule conversion (`region` +
  `'public'`, `site_id` dropped).
- **Dispatch API:** per-tier pooled dispatch end-to-end (private / team with
  org fixtures / public); 400s: missing tier, both targeting forms at once,
  `team` without org, `shared`, inactive region; 403: session-injected
  workflow into the `public` pool; legacy in-flight job (null targetTier)
  still claimable under the old arm.
- **Scheduler:** stamps region+tier onto created jobs.
- **Reaper:** pooled job survives the 15-min window with no online agent;
  targeted job still fast-fails; 24h backstop reason names the pool.
- **Wire contract (`site-id-wire.test.ts` extension):** run/schedule bodies
  take `region` + `targetTier` (no `siteId` body key); `run-targets` `tiers`
  block shape; pending pooled job rows expose `targetRegion`/`targetTier` with
  null `siteId`.
- **E2E:** selector renders region + tier controls; team tier disabled without
  org; empty-pool notice.

## 13. Files touched (orientation, not exhaustive)

| Area | Files |
|---|---|
| Schema + migration | `shared/schema.ts`, `migrations/0034_tier_targeting.sql`, `server/migrate.ts` |
| Predicate | `server/permissions.ts` (`isClaimable`), `server/storage.ts` (claim SQL, token mint region-stamp, reaper split) |
| Routes | `server/routes.ts` (run route, eval-schedules, run-targets `tiers`, dispatchable) |
| Scheduler | `server/index.ts` (job stamping; reaper wording) |
| Client | `run-your-own.tsx`, `console-workflow-detail.tsx`, `console-evalsets.tsx`, `console-eval-jobs.tsx` (display), schedules UI, `use-regions.ts` (already has the hooks) |
| Tests | new predicate/matrix + migration tests; extensions to `api.test.ts`, `dispatch-integration.test.ts`, `site-id-wire.test.ts`, e2e specs |
