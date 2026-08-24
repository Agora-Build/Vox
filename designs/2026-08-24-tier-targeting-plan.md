# Tier-Targeting (Region-Pooled Dispatch by Agent Tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace exact-site untargeted dispatch with region × tier pools: a job targets `(targetRegion, targetTier)` and any consenting agent in that region claims it, stamping its concrete site at claim.

**Architecture:** New nullable `target_region`/`target_tier` columns on `eval_jobs` (+ `region` on tokens, region+tier on schedules) with a three-arm claim predicate (targeted / pooled / legacy) mirrored bit-for-bit between `permissions.isClaimable` and the storage SQL. Pooled jobs are born site-less and queue until claimed (no fast-fail); the run/schedule routes take `{region, targetTier}`; run-targets advertises server-computed tier availability so the UI never offers a 4xx.

**Tech Stack:** Express + Drizzle ORM + raw pg for atomic claims; React + TanStack Query + shadcn/ui; Vitest + Playwright.

**Spec:** `designs/2026-08-24-tier-targeting-design.md` (identical copy at `docs/superpowers/specs/2026-08-24-tier-targeting-design.md`). Read it first.

## Global Constraints

- Commit messages end with a blank line then exactly: `🤖 Built with SMT <smt@agora.build>`
- File-scoped `git add` only. NEVER stage `vox_eval_agentd/aeval-data`.
- Migration: `migrations/0034_tier_targeting.sql`, registered as **version 35** in `server/migrate.ts` `MIGRATIONS`. Plain SQL (no `IF NOT EXISTS`), `--> statement-breakpoint` between statements (house style: see `migrations/0033_region_to_site_id.sql`).
- Reuse the existing `dispatch_tier` pg enum for `target_tier` — do NOT create a new enum. `'shared'` is a reserved value: the enum admits it, dispatch rejects it.
- The claim predicate lives in TWO places that must match bit-for-bit: `server/permissions.ts:isClaimable` (source of truth) and the SQL in `storage.claimEvalJob`/`getClaimableJobsForToken`.
- Vocabulary: `region` = `na-us-seattle` (a `region_locations.baseId`); `siteId` = `na-us-seattle-02`. Test helpers: `REGION_NA` = `"na-us-seattle-01"` (a SITE), `BASE_NA` = `"na-us-seattle"` (a REGION) — from `tests/helpers/regions.ts`. Pooled dispatch takes BASE_* values, never REGION_*.
- Local test env: `export DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox"`; integration tests need the dev server running — **`npm run dev` has NO watch mode**: after editing server code, restart with `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start` before running integration tests.
- DB pollution discipline: before a full run, `docker exec vox-postgres psql -U vox -d vox -c "UPDATE clash_runner_pool SET current_match_id=NULL, state='idle' WHERE current_match_id IS NOT NULL; DELETE FROM clash_matches; DELETE FROM clash_events; DELETE FROM workflows WHERE owner_id=1; DELETE FROM projects WHERE owner_id=1;"`
- Monorepo-green point: `npm run check` must be clean after every task; the FULL vitest suite is green only after Task 6 (Tasks 3–5 knowingly leave stale sibling tests that Task 6 migrates). Each task's gate is its own named test files.

---

### Task 1: Schema + migration 0034 + token region stamp

**Files:**
- Modify: `shared/schema.ts` (evalAgentTokens ~line 205, evalSchedules ~line 264, evalJobs ~line 337, insertEvalAgentTokenSchema ~line 218)
- Create: `migrations/0034_tier_targeting.sql`
- Modify: `server/migrate.ts` (MIGRATIONS array, after the version-34 entry)
- Modify: `server/storage.ts` (`createEvalAgentTokenForLocation` ~line 485, `createEvalAgentToken` ~line 656)
- Test: `tests/tier-targeting-schema.test.ts` (create)

**Interfaces:**
- Consumes: existing `dispatchTierEnum` (`shared/schema.ts` line 13).
- Produces (later tasks rely on these exact names):
  - `evalAgentTokens.region: varchar(64) NOT NULL` (drizzle property `region`)
  - `evalJobs.siteId` nullable; `evalJobs.targetRegion: varchar(64) | null` (property `targetRegion`); `evalJobs.targetTier: dispatch_tier | null` (property `targetTier`)
  - `evalSchedules.region: varchar(64) NOT NULL` (property `region`); `evalSchedules.targetTier: dispatch_tier NOT NULL DEFAULT 'public'` (property `targetTier`); `evalSchedules.siteId` REMOVED
  - `storage.createEvalAgentToken` derives `region` from `siteId` when not supplied (existing test fixtures keep working)

- [ ] **Step 1: Write the failing schema test**

Create `tests/tier-targeting-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("tier-targeting schema", () => {
  it("createEvalAgentToken derives region from siteId when absent", async () => {
    const token = await storage.createEvalAgentToken({
      name: `tt-schema-${Date.now()}`,
      tokenHash: `tt-schema-${Date.now()}`,
      siteId: "na-us-ashburn-01",
      createdBy: 1,
    } as any);
    expect(token.region).toBe("na-us-ashburn");
  });

  it("createEvalAgentTokenForLocation stamps region = baseId", async () => {
    const token = await storage.createEvalAgentTokenForLocation("na-us-seattle", {
      name: `tt-mint-${Date.now()}`,
      tokenHash: `tt-mint-${Date.now()}`,
      dispatchTier: "public",
      createdBy: 1,
      isRevoked: false,
    } as any);
    expect(token.region).toBe("na-us-seattle");
    expect(token.siteId.startsWith("na-us-seattle-")).toBe(true);
  });

  it("createEvalJob accepts a site-less pooled job", async () => {
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 1,
      siteId: null, targetRegion: "na-us-seattle", targetTier: "public",
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe("na-us-seattle");
    expect(job.targetTier).toBe("public");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/tier-targeting-schema.test.ts`
Expected: FAIL (`region` undefined on the returned token; NOT NULL violation on `site_id` for the pooled job).

- [ ] **Step 3: Edit `shared/schema.ts`**

In `evalAgentTokens` (after the `siteId` line):

```ts
  siteId: varchar("site_id", { length: 64 }).notNull(),
  // Region baseId (e.g. "na-us-seattle") — the pool an agent serves. Stamped at
  // mint (siteId = region + allocated sequence), backfilled in migration 0034.
  region: varchar("region", { length: 64 }).notNull(),
```

In `insertEvalAgentTokenSchema`, add `region: true` to the `.omit({...})` object (storage derives it — callers never supply it).

In `evalJobs`, change the `siteId` line and add two columns next to `targetTokenId`:

```ts
  targetTokenId: integer("target_token_id").references(() => evalAgentTokens.id, { onDelete: "set null" }),
  // Pooled targeting: (targetRegion, targetTier) — "any agent of this tier in
  // this region". Exactly one of targetTokenId / (targetRegion+targetTier) is
  // set on new rows; legacy rows have siteId set and all three null.
  targetRegion: varchar("target_region", { length: 64 }),
  targetTier: dispatchTierEnum("target_tier"),
```

and make `siteId` nullable (remove `.notNull()`):

```ts
  // Concrete site that ran (or will run) the job. Pooled jobs are born null;
  // the claiming agent stamps it atomically inside claimEvalJob.
  siteId: varchar("site_id", { length: 64 }),
```

In `evalSchedules`, REPLACE the `siteId` line with:

```ts
  // Pool the schedule dispatches into: region baseId + tier (spec §4/§5).
  region: varchar("region", { length: 64 }).notNull(),
  targetTier: dispatchTierEnum("target_tier").default("public").notNull(),
```

- [ ] **Step 4: Write `migrations/0034_tier_targeting.sql`**

```sql
-- Tier-targeting: region×tier pools (designs/2026-08-24-tier-targeting-design.md).
-- Tokens learn their region; jobs gain (target_region, target_tier) and a
-- nullable site_id (stamped at claim); schedules move from exact site to pool.
ALTER TABLE "eval_agent_tokens" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
UPDATE "eval_agent_tokens" SET "region" = regexp_replace("site_id", '-[0-9]+$', '');
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "region" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "eval_agent_tokens_region_idx" ON "eval_agent_tokens" ("region");
--> statement-breakpoint
ALTER TABLE "eval_jobs" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "target_region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "target_tier" dispatch_tier;
--> statement-breakpoint
CREATE INDEX "eval_jobs_pending_pool_idx" ON "eval_jobs" ("target_region", "target_tier") WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE "eval_schedules" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
UPDATE "eval_schedules" SET "region" = regexp_replace("site_id", '-[0-9]+$', '');
--> statement-breakpoint
ALTER TABLE "eval_schedules" ALTER COLUMN "region" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_schedules" ADD COLUMN "target_tier" dispatch_tier DEFAULT 'public' NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_schedules" DROP COLUMN "site_id";
```

Register in `server/migrate.ts` after the version-34 entry:

```ts
  { version: 35, description: "tier-targeting: token region, job target_region/target_tier (site_id nullable), schedule region+target_tier", file: "0034_tier_targeting.sql" },
```

- [ ] **Step 5: Stamp region in `server/storage.ts`**

In `createEvalAgentTokenForLocation` (~line 505), the INSERT becomes:

```ts
      const inserted = await client.query(
        `INSERT INTO eval_agent_tokens
          (name, token_hash, site_id, region, dispatch_tier, created_by, is_revoked, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          token.name,
          token.tokenHash,
          siteId,
          selected.rows[0].base_id,
          token.dispatchTier,
          token.createdBy,
          token.isRevoked,
          token.expiresAt ?? null,
        ],
      );
```

and add `region: row.region,` to the returned object literal (next to `siteId: row.site_id,`).

In `createEvalAgentToken` (~line 656), derive region so existing fixtures (which pass only `siteId`) keep working:

```ts
  async createEvalAgentToken(token: InsertEvalAgentToken): Promise<EvalAgentToken> {
    // Fixtures/tests pass a bare siteId; region is derivable (strip -NN).
    const values = { ...token, region: (token as { region?: string }).region ?? token.siteId.replace(/-\d+$/, "") };
    const result = await db.insert(evalAgentTokens).values(values).returning();
    return result[0];
  }
```

- [ ] **Step 6: Apply the migration locally and run the test**

```bash
docker exec vox-postgres psql -U vox -d vox -f /dev/stdin < migrations/0034_tier_targeting.sql
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/tier-targeting-schema.test.ts
npm run check
```

Expected: migration applies cleanly (each statement succeeds; the `-->` breakpoint comment lines are SQL comments to psql), test PASSES, tsc has NO server/shared errors. Client errors ARE expected at this point only if any client file names `schedule.siteId` in a typed position — note them; Task 5 fixes them. If `npm run check` is fully clean, say so in the report.

- [ ] **Step 7: Commit**

```bash
git add shared/schema.ts migrations/0034_tier_targeting.sql server/migrate.ts server/storage.ts tests/tier-targeting-schema.test.ts
git commit -m "feat(schema): tier-targeting columns — token region, job pool target, schedule pool

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: Claim predicate — permissions, storage SQL, reapers

**Files:**
- Modify: `server/permissions.ts` (`isClaimable`, ~line 130)
- Modify: `server/storage.ts` (`claimEvalJob` ~line 870, `getClaimableJobsForToken` ~line 923, DELETE `claimNextAvailableJob` ~line 943 (dead — zero call sites, verify with `grep -rn "claimNextAvailableJob" server/ tests/ client/`), `failPendingJobsWithNoAgent` ~line 1053, `failExpiredPendingJobs` ~line 1083)
- Modify: `server/routes.ts` — the two callers: jobs listing (~line 3254) and claim (~line 3333)
- Test: `tests/permissions-dispatch.test.ts` (extend), `tests/tier-pool-claim.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 columns; existing `sameOrg` from `server/permissions.ts`.
- Produces:
  - `isClaimable(job, token, orgs?)` with the exact signature in Step 3 — Task 3's route logic and all tests use it.
  - `storage.getClaimableJobsForToken(token: { id: number; siteId: string; region: string; dispatchTier: string; createdBy: number; ownerOrgId: number | null })`
  - `storage.claimEvalJob(jobId, agentId, token: { id: number; siteId: string; region: string; dispatchTier: string; createdBy: number; ownerOrgId: number | null })`

- [ ] **Step 1: Write the failing predicate matrix test**

Extend `tests/permissions-dispatch.test.ts` with a new describe (keep existing tests; they will be updated in Step 3 to the new signature):

```ts
describe("isClaimable — pooled arms (tier-targeting)", () => {
  const T = (over: Partial<{ id: number; region: string; siteId: string; dispatchTier: string; createdBy: number }> = {}) =>
    ({ id: 1, region: "na-us-seattle", siteId: "na-us-seattle-01", dispatchTier: "public", createdBy: 7, ...over }) as any;
  const pooled = (tier: string, over: Record<string, unknown> = {}) =>
    ({ targetTokenId: null, targetRegion: "na-us-seattle", targetTier: tier, siteId: null, createdBy: 9, ...over }) as any;

  it("public pool: public token in region claims; region mismatch refused", () => {
    expect(isClaimable(pooled("public"), T())).toBe(true);
    expect(isClaimable(pooled("public"), T({ region: "eu-de-frankfurt" }))).toBe(false);
  });
  it("public pool: private/team tokens refused; session-injected refused", () => {
    expect(isClaimable(pooled("public"), T({ dispatchTier: "private" }))).toBe(false);
    expect(isClaimable(pooled("public"), T({ dispatchTier: "team" }))).toBe(false);
    expect(isClaimable(pooled("public", { sessionInjected: true }), T())).toBe(false);
  });
  it("private pool: only the dispatcher's own tokens, any tier", () => {
    expect(isClaimable(pooled("private", { createdBy: 7 }), T({ dispatchTier: "private" }))).toBe(true);
    expect(isClaimable(pooled("private", { createdBy: 7 }), T({ dispatchTier: "public" }))).toBe(true);
    expect(isClaimable(pooled("private", { createdBy: 9 }), T())).toBe(false);
  });
  it("team pool: mutual consent — org-mate's team/public token yes, private token NO", () => {
    const orgs = { tokenOwnerOrgId: 5, creatorOrgId: 5 };
    expect(isClaimable(pooled("team"), T({ dispatchTier: "team" }), orgs)).toBe(true);
    expect(isClaimable(pooled("team"), T({ dispatchTier: "public" }), orgs)).toBe(true);
    expect(isClaimable(pooled("team"), T({ dispatchTier: "private" }), orgs)).toBe(false);
    expect(isClaimable(pooled("team"), T({ dispatchTier: "team" }), { tokenOwnerOrgId: 5, creatorOrgId: 6 })).toBe(false);
    expect(isClaimable(pooled("team"), T({ dispatchTier: "team" }), { tokenOwnerOrgId: null, creatorOrgId: null })).toBe(false);
  });
  it("shared pool: nothing claims it this cycle", () => {
    expect(isClaimable(pooled("shared"), T())).toBe(false);
  });
  it("legacy site-pinned rows keep the old arm (site equality + public-or-mine)", () => {
    const legacy = { targetTokenId: null, targetRegion: null, targetTier: null, siteId: "na-us-seattle-01", createdBy: 9 } as any;
    expect(isClaimable(legacy, T())).toBe(true);
    expect(isClaimable(legacy, T({ siteId: "na-us-seattle-02" }))).toBe(false);
    expect(isClaimable({ ...legacy, createdBy: 7 }, T({ dispatchTier: "private" }))).toBe(true);
  });
  it("targeted jobs match ONLY the aimed token — never a pool/legacy arm", () => {
    const targeted = { targetTokenId: 42, targetRegion: null, targetTier: null, siteId: "na-us-seattle-01", createdBy: 7 } as any;
    expect(isClaimable(targeted, T({ id: 42 }))).toBe(true);
    expect(isClaimable(targeted, T({ id: 1 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/permissions-dispatch.test.ts`
Expected: FAIL (new arms don't exist).

- [ ] **Step 3: Rewrite `isClaimable` in `server/permissions.ts`**

Replace the existing function (keep its doc comment, extend it):

```ts
export function isClaimable(
  job: {
    targetTokenId: number | null;
    targetRegion?: string | null;
    targetTier?: "private" | "team" | "public" | "shared" | null;
    siteId?: string | null;
    createdBy: number | null;
    sessionInjected?: boolean;
  },
  token: Pick<DispatchToken, "id" | "dispatchTier" | "createdBy"> & { region?: string; siteId?: string },
  orgs?: { tokenOwnerOrgId: number | null; creatorOrgId: number | null },
): boolean {
  // Targeted: only the aimed token, ever.
  if (job.targetTokenId != null) return job.targetTokenId === token.id;

  // Pooled: region match + mutual consent (dispatcher's requested pool ∩
  // the owner's offered dispatchTier). Spec §6.
  if (job.targetRegion != null) {
    if (token.region !== job.targetRegion) return false;
    switch (job.targetTier) {
      case "private":
        return job.createdBy === token.createdBy;
      case "team":
        return (token.dispatchTier === "team" || token.dispatchTier === "public")
          && sameOrg(
            { organizationId: orgs?.tokenOwnerOrgId ?? null },
            { organizationId: orgs?.creatorOrgId ?? null },
          );
      case "public":
        return token.dispatchTier === "public" && !job.sessionInjected;
      default:
        return false; // 'shared' reserved; null malformed
    }
  }

  // Legacy site-pinned rows (pre-tier-targeting), until drained: site equality
  // + the old public-or-mine arm.
  if (job.siteId == null || job.siteId !== token.siteId) return false;
  if (job.createdBy === token.createdBy) return true;
  return token.dispatchTier === "public" && !job.sessionInjected;
}
```

Update the PRE-EXISTING tests in `tests/permissions-dispatch.test.ts` that call `isClaimable`: they model legacy untargeted jobs, so add `targetRegion: null, targetTier: null, siteId: "na-us-seattle-01"` to their job objects and `siteId: "na-us-seattle-01"` to their token objects (the old tests had no site fence because the site filter lived outside the predicate; the predicate is now complete).

- [ ] **Step 4: Run the matrix test**

Run: `npx vitest run tests/permissions-dispatch.test.ts`
Expected: PASS (both old-updated and new describes).

- [ ] **Step 5: Mirror in storage SQL**

In `server/storage.ts`, replace `getClaimableJobsForToken` with:

```ts
  async getClaimableJobsForToken(token: {
    id: number; siteId: string; region: string; dispatchTier: string; createdBy: number; ownerOrgId: number | null;
  }): Promise<EvalJob[]> {
    // Mirrors permissions.isClaimable() bit for bit (targeted / pooled / legacy).
    const result = await pool.query(
      `SELECT ej.* FROM eval_jobs ej
        LEFT JOIN users creator ON ej.created_by = creator.id
        WHERE ej.status = 'pending'::eval_job_status
          AND (
            ej.target_token_id = $1
            OR ( ej.target_region IS NOT NULL AND ej.target_region = $2 AND (
                   ( ej.target_tier = 'private'::dispatch_tier AND ej.created_by = $5 )
                OR ( ej.target_tier = 'team'::dispatch_tier
                     AND $4 IN ('team', 'public')
                     AND $6::integer IS NOT NULL AND creator.organization_id = $6 )
                OR ( ej.target_tier = 'public'::dispatch_tier AND $4 = 'public'
                     AND (ej.config -> 'sessionInjection') IS NULL )
            ) )
            OR ( ej.target_token_id IS NULL AND ej.target_region IS NULL AND ej.site_id = $3 AND (
                   ej.created_by = $5
                   OR ( $4 = 'public' AND (ej.config -> 'sessionInjection') IS NULL )
            ) )
          )
        ORDER BY ej.priority DESC, ej.created_at ASC`,
      [token.id, token.region, token.siteId, token.dispatchTier, token.createdBy, token.ownerOrgId],
    );
    return result.rows.map((r) => snakeToCamel(r) as EvalJob);
  }
```

Replace `claimEvalJob`'s SELECT + UPDATE with the same predicate (job-id-scoped) and the site stamp:

```ts
  async claimEvalJob(
    jobId: number,
    agentId: number,
    token: { id: number; siteId: string; region: string; dispatchTier: string; createdBy: number; ownerOrgId: number | null },
  ): Promise<EvalJob | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // WHERE mirrors permissions.isClaimable() bit for bit.
      const selectResult = await client.query(
        `SELECT ej.* FROM eval_jobs ej
         LEFT JOIN users creator ON ej.created_by = creator.id
         WHERE ej.id = $1 AND ej.status = 'pending'::eval_job_status
           AND (
             ej.target_token_id = $2
             OR ( ej.target_region IS NOT NULL AND ej.target_region = $3 AND (
                    ( ej.target_tier = 'private'::dispatch_tier AND ej.created_by = $5 )
                 OR ( ej.target_tier = 'team'::dispatch_tier
                      AND $4 IN ('team', 'public')
                      AND $6::integer IS NOT NULL AND creator.organization_id = $6 )
                 OR ( ej.target_tier = 'public'::dispatch_tier AND $4 = 'public'
                      AND (ej.config -> 'sessionInjection') IS NULL )
             ) )
             OR ( ej.target_token_id IS NULL AND ej.target_region IS NULL AND ej.site_id = $7 AND (
                    ej.created_by = $5
                    OR ( $4 = 'public' AND (ej.config -> 'sessionInjection') IS NULL )
             ) )
           )
         FOR UPDATE OF ej SKIP LOCKED`,
        [jobId, token.id, token.region, token.dispatchTier, token.createdBy, token.ownerOrgId, token.siteId]
      );
      if (selectResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      // token_dispatch_tier frozen + site stamped in the same atomic update:
      // a pooled job (site_id NULL) records the claiming agent's concrete site.
      const updateResult = await client.query(
        `UPDATE eval_jobs
         SET eval_agent_id = $1, status = 'running'::eval_job_status, started_at = NOW(), updated_at = NOW(),
             token_dispatch_tier = $3,
             site_id = COALESCE(site_id, $4)
         WHERE id = $2
         RETURNING *`,
        [agentId, jobId, token.dispatchTier, token.siteId]
      );
      await client.query('COMMIT');
      return snakeToCamel(updateResult.rows[0]) as EvalJob;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
```

DELETE the entire `claimNextAvailableJob` method (dead code — confirm zero call sites first) and remove it from the `IStorage` interface if declared there.

- [ ] **Step 6: Update the two route callers in `server/routes.ts`**

Both the agent jobs listing (~3254) and the claim route (~3333) currently pass `{ id, siteId, dispatchTier, createdBy }`-shaped tokens. Each handler has the `evalAgentToken` row in scope; extend the argument with `region` and the owner's org (one user lookup):

```ts
      const tokenOwner = await storage.getUser(evalAgentToken.createdBy);
      // ...existing code...
      let jobs = await storage.getClaimableJobsForToken({
        id: evalAgentToken.id,
        siteId: evalAgentToken.siteId,
        region: evalAgentToken.region,
        dispatchTier: evalAgentToken.dispatchTier,
        createdBy: evalAgentToken.createdBy,
        ownerOrgId: tokenOwner?.organizationId ?? null,
      });
```

and the claim call analogously (same six fields). Match the surrounding variable names — read the two handlers before editing.

- [ ] **Step 7: Make the reapers pool-aware**

`failPendingJobsWithNoAgent`: add two conditions to the WHERE so only site-pinned rows (targeted + legacy) fast-fail — pooled jobs are queues (spec §7):

```sql
      WHERE status = 'pending'::eval_job_status
      AND site_id IS NOT NULL
      AND target_region IS NULL
      AND GREATEST(created_at, updated_at) < ${timeoutCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM eval_agents ea
        WHERE ea.site_id = eval_jobs.site_id
        AND ea.last_seen_at >= ${onlineCutoff}
      )
```

`failExpiredPendingJobs`: make the error message name the pool:

```ts
    const message = `Not claimed by any eval agent within ${maxWaitMinutes} min`;
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET status = 'failed'::eval_job_status,
          error = CASE
            WHEN target_region IS NOT NULL
              THEN 'No eligible ' || target_tier || ' agent in ' || target_region || ' claimed the job within ' || ${maxWaitMinutes} || ' min'
            ELSE ${message}
          END,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE status = 'pending'::eval_job_status
      AND GREATEST(created_at, updated_at) < ${cutoff}
    `);
```

- [ ] **Step 8: Write the SQL-mirror integration test**

Create `tests/tier-pool-claim.test.ts` (storage-level, DB-gated like `tests/shared-agents-reap-query.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { storage } from "../server/storage";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// admin (id 1) exists after dev-DB init. Tokens created via createEvalAgentToken
// derive region from siteId (Task 1).
const mkToken = (name: string, siteId: string, tier = "public", createdBy = 1) =>
  storage.createEvalAgentToken({
    name, tokenHash: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    siteId, dispatchTier: tier, createdBy,
  } as any);

const mkPooledJob = (targetRegion: string, targetTier: string, createdBy = 1) =>
  storage.createEvalJob({
    workflowId: null, triggerType: 2, evalSetId: null, createdBy,
    siteId: null, targetRegion, targetTier,
    config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);

d("pooled claim SQL mirrors isClaimable", () => {
  it("public pool: in-region public token lists+claims and stamps its site", async () => {
    const tok = await mkToken(`tp-pub-${Date.now()}`, "na-us-ashburn-01");
    const job = await mkPooledJob("na-us-ashburn", "public", 2); // creator 2 = scout
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    const listed = await storage.getClaimableJobsForToken(arg);
    expect(listed.map(j => j.id)).toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `tp-a-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    const claimed = await storage.claimEvalJob(job.id, agent.id, arg);
    expect(claimed).toBeDefined();
    expect(claimed!.siteId).toBe(tok.siteId); // pooled job stamped at claim
    expect(claimed!.tokenDispatchTier).toBe("public");
  });

  it("region mismatch: out-of-region token neither lists nor claims", async () => {
    const tok = await mkToken(`tp-eu-${Date.now()}`, "eu-de-frankfurt-01");
    const job = await mkPooledJob("na-us-ashburn", "public", 2);
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(arg)).map(j => j.id)).not.toContain(job.id);
    const agent = await storage.createEvalAgent({ tokenId: tok.id, name: `tp-ae-${Date.now()}`, siteId: tok.siteId, state: "idle", metadata: {} } as any);
    expect(await storage.claimEvalJob(job.id, agent.id, arg)).toBeUndefined();
  });

  it("private pool: own token (any tier) claims; stranger's token does not", async () => {
    const mine = await mkToken(`tp-mine-${Date.now()}`, "na-us-ashburn-01", "private", 1);
    const job = await mkPooledJob("na-us-ashburn", "private", 1);
    const strangerTok = await mkToken(`tp-str-${Date.now()}`, "na-us-ashburn-01", "public", 2);
    const strangerArg = { id: strangerTok.id, siteId: strangerTok.siteId, region: strangerTok.region, dispatchTier: strangerTok.dispatchTier, createdBy: strangerTok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(strangerArg)).map(j => j.id)).not.toContain(job.id);
    const mineArg = { id: mine.id, siteId: mine.siteId, region: mine.region, dispatchTier: mine.dispatchTier, createdBy: mine.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(mineArg)).map(j => j.id)).toContain(job.id);
  });

  it("reaper: pooled pending job is NOT fast-failed by the no-agent sweep; site-pinned is", async () => {
    const pooled = await mkPooledJob("sa-br-saopaulo", "public", 2); // region with no online agent
    const pinned = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
      siteId: "sa-br-saopaulo-01", targetRegion: null, targetTier: null,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    // timeoutMinutes=0: everything pending is past the cutoff immediately.
    await storage.failPendingJobsWithNoAgent(0, 5);
    const pooledAfter = await storage.getEvalJob(pooled.id);
    const pinnedAfter = await storage.getEvalJob(pinned.id);
    expect(pooledAfter!.status).toBe("pending"); // pools are queues (spec §7)
    expect(pinnedAfter!.status).toBe("failed");  // site-pinned keeps the fast-fail
  });

  it("legacy site-pinned row still claimable under the old arm", async () => {
    const tok = await mkToken(`tp-leg-${Date.now()}`, "na-us-ashburn-01");
    const job = await storage.createEvalJob({
      workflowId: null, triggerType: 2, evalSetId: null, createdBy: 2,
      siteId: "na-us-ashburn-01", targetRegion: null, targetTier: null,
      config: {}, snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);
    const arg = { id: tok.id, siteId: tok.siteId, region: tok.region, dispatchTier: tok.dispatchTier, createdBy: tok.createdBy, ownerOrgId: null };
    expect((await storage.getClaimableJobsForToken(arg)).map(j => j.id)).toContain(job.id);
  });
});
```

Note: if `storage.createEvalAgent`'s actual signature differs (check it), adapt the two agent creations — the assertion that matters is the claim result, not how the agent row is made.

- [ ] **Step 9: Run both test files + typecheck**

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/permissions-dispatch.test.ts tests/tier-pool-claim.test.ts
npm run check
```

Expected: PASS, tsc clean.

- [ ] **Step 10: Commit**

```bash
git add server/permissions.ts server/storage.ts server/routes.ts tests/permissions-dispatch.test.ts tests/tier-pool-claim.test.ts
git commit -m "feat(dispatch): three-arm claim predicate — targeted / region×tier pool / legacy

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Dispatch API — run route, schedules, scheduler

**Files:**
- Modify: `server/routes.ts` — run route pooled branch (~3977–4045), eval-schedules create (~2124) and update handler
- Modify: `server/index.ts` — scheduler job creation (~line 432 `siteId: schedule.siteId`)
- Test: `tests/tier-pool-dispatch.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 columns; `hasOrg` from `server/permissions.ts`; existing `sessionNeed` variable in the run route (computed at ~3887); existing `evaluateSessionRequirement`/`parsePlatformSetup`/`sessionScopeForWorkflow`/`getBrokeredSecretNames` imports (already used by the run route).
- Produces: run body contract `{ targetTokenId?, region?, targetTier?, evalSetId }`; schedule body contract `{ region, targetTier, ... }` — Tasks 4–6 and the client rely on these names.

- [ ] **Step 1: Write the failing API test**

Create `tests/tier-pool-dispatch.test.ts` (HTTP-level, needs the dev server; reuse the login/authFetch pattern from `tests/dispatch-integration.test.ts` verbatim — copy its `login`/`authFetch` helpers):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { BASE_NA } from "./helpers/regions";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

describe("pooled dispatch API", () => {
  let cookie: string; let workflowId: number; let evalSetId: number;

  beforeAll(async () => {
    cookie = await login();
    const wf = await (await authFetch(cookie, `${BASE_URL}/api/workflows?includePublic=true`)).json();
    workflowId = wf[0].id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;
  });

  const run = (body: Record<string, unknown>) =>
    authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run`, { method: "POST", body: JSON.stringify(body) });

  it("public pool dispatch creates a site-less job carrying region+tier", async () => {
    const res = await run({ region: BASE_NA, targetTier: "public", evalSetId });
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe(BASE_NA);
    expect(job.targetTier).toBe("public");
    expect(job.targetTokenId).toBeNull();
  });

  it("private pool dispatch works for anyone", async () => {
    const res = await run({ region: BASE_NA, targetTier: "private", evalSetId });
    expect(res.status).toBe(200);
    expect((await res.json()).job.targetTier).toBe("private");
  });

  it("rejects: missing tier, unknown tier, shared, inactive region, both forms", async () => {
    expect((await run({ region: BASE_NA, evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "bogus", evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "shared", evalSetId })).status).toBe(400);
    expect((await run({ region: "not-a-region", targetTier: "public", evalSetId })).status).toBe(400);
    expect((await run({ region: BASE_NA, targetTier: "public", targetTokenId: 1, evalSetId })).status).toBe(400);
  });

  it("rejects team pool for a user with no org", async () => {
    // admin has no organization in the dev seed
    const res = await run({ region: BASE_NA, targetTier: "team", evalSetId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/organization/i);
  });

  it("schedule create takes region+targetTier and the scheduler contract stores them", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/eval-schedules`, {
      method: "POST",
      body: JSON.stringify({
        name: `tt-sched-${Date.now()}`, workflowId, evalSetId,
        region: BASE_NA, targetTier: "public", scheduleType: "recurring", cronExpression: "0 3 * * *",
      }),
    });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.region).toBe(BASE_NA);
    expect(sched.targetTier).toBe("public");
    // cleanup
    await authFetch(cookie, `${BASE_URL}/api/eval-schedules/${sched.id}`, { method: "DELETE" });
  });
});
```

(Adjust the schedule-create response field access if the route wraps it — read the handler's `res.json(...)` shape first and assert on the actual shape; the requirement is that region+targetTier round-trip.)

- [ ] **Step 2: Run to verify it fails**

Restart the server first (no watch): `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start`
Run: `DATABASE_URL=... npx vitest run tests/tier-pool-dispatch.test.ts`
Expected: FAIL (route still requires `siteId`).

- [ ] **Step 3: Rewrite the run route's targeting parse + pooled branch**

At ~3830, replace:

```ts
      const { evalSetId } = req.body;
      const region = req.body.siteId;
```

with:

```ts
      const { evalSetId } = req.body;
      // Pooled targeting: region baseId + tier (spec §5). Exactly one of
      // targetTokenId / (region+targetTier) may be supplied.
      const region = req.body.region != null ? String(req.body.region) : null;
      const targetTier = req.body.targetTier != null ? String(req.body.targetTier) : null;
```

After the existing `targetTokenId` parse, add the exactly-one guard:

```ts
      if (targetTokenId != null && (region != null || targetTier != null)) {
        return res.status(400).json({ error: "Provide either targetTokenId or region+targetTier, not both" });
      }
```

Replace the untargeted branch's site validation (currently `normalizedRegion` + `isAllocatedSite` at ~3993-3998) with:

```ts
        if (!region || !targetTier) {
          return res.status(400).json({ error: "region and targetTier are required for pooled dispatch" });
        }
        if (targetTier === "shared") {
          return res.status(400).json({ error: "Pooled shared dispatch is not available" });
        }
        if (!["private", "team", "public"].includes(targetTier)) {
          return res.status(400).json({ error: "Invalid targetTier" });
        }
        if (targetTier === "team" && !hasOrg(user)) {
          return res.status(400).json({ error: "Join an organization to use team agents" });
        }
        const regionLoc = (await storage.getAllRegionLocations()).find((l) => l.baseId === region && l.isActive);
        if (!regionLoc) {
          return res.status(400).json({ error: "region must be an active region" });
        }
        // Session-injection composition (spec §5): the serve gate admits owner +
        // team agents only, so a public-pool claim would take the job and then be
        // refused the session. Reject up front. (The existing owner-or-org guard
        // above already limits WHO may dispatch a session workflow untargeted.)
        if (sessionNeed && targetTier === "public") {
          return res.status(403).json({ error: "Credential-injected workflows can only use your own or team agent pools" });
        }
        jobRegion = null; // pooled: site stamped at claim
```

KEEP the existing `sessionNeed` owner-or-org 403 guard that opens the untargeted branch — it stays, verbatim, before the new code. The variable `jobRegion` becomes `string | null`; update its declaration (`let jobRegion: string | null;`). The `createEvalJob` call changes to:

```ts
        job = await storage.createEvalJob({
          workflowId: parseInt(workflowId),
          triggerType: 2, // manual (Run Workflow)
          evalSetId,
          createdBy: user.id,
          siteId: jobRegion,
          targetRegion: targeting == null ? region : null,
          targetTier: targeting == null ? (targetTier as "private" | "team" | "public") : null,
          targetTokenId: targeting,
          config: jobConfig,
          snapshot,
          status: "pending",
          priority: 0,
          retryCount: 0,
          maxRetries: 3,
        });
```

(The targeted branch still sets `jobRegion = token.siteId` — unchanged.)

Add `hasOrg` to the existing `permissions` import in routes.ts if not already imported.

- [ ] **Step 4: Rewrite eval-schedules create (+ update) targeting**

At ~2124 replace:

```ts
      const region = req.body.siteId;

      if (!name || !workflowId || !region) {
        return res.status(400).json({ error: "Name, workflowId, and siteId are required" });
      }

      const normalizedRegion = String(region);
      if (!(await storage.isAllocatedSite(normalizedRegion))) {
        return res.status(400).json({ error: "Region must be an active allocated site ID" });
      }
```

with:

```ts
      const region = req.body.region != null ? String(req.body.region) : null;
      const targetTier = req.body.targetTier != null ? String(req.body.targetTier) : null;

      if (!name || !workflowId || !region || !targetTier) {
        return res.status(400).json({ error: "Name, workflowId, region, and targetTier are required" });
      }
      if (targetTier === "shared" || !["private", "team", "public"].includes(targetTier)) {
        return res.status(400).json({ error: targetTier === "shared" ? "Pooled shared dispatch is not available" : "Invalid targetTier" });
      }
      if (targetTier === "team" && !hasOrg(user)) {
        return res.status(400).json({ error: "Join an organization to use team agents" });
      }
      const regionLoc = (await storage.getAllRegionLocations()).find((l) => l.baseId === region && l.isActive);
      if (!regionLoc) {
        return res.status(400).json({ error: "region must be an active region" });
      }
```

After the workflow + eval-set are loaded (the handler already loads both), add the session-composition guard, mirroring the run route's detection exactly:

```ts
      // Session-injection composition (spec §5): scheduled session workflows may
      // only use private/team pools — same rule as the run route.
      {
        const wfConfig = (workflow.config ?? {}) as Record<string, unknown>;
        const setupInfo = parsePlatformSetup(wfConfig.stepsPrefix as string | undefined);
        const scope = sessionScopeForWorkflow(workflow);
        const schedSessionReq = evaluateSessionRequirement(setupInfo, await getBrokeredSecretNames(scope));
        if (schedSessionReq.kind === "need" && targetTier === "public") {
          return res.status(403).json({ error: "Credential-injected workflows can only use your own or team agent pools" });
        }
      }
```

Where the schedule row is inserted, pass `region` and `targetTier` instead of `siteId` (the drizzle insert takes the schema property names from Task 1). If a schedule-update/PATCH handler writes `siteId`, apply the same substitution and validation there (grep the file for `eval-schedules` handlers).

- [ ] **Step 5: Scheduler stamps the pool**

In `server/index.ts` `processScheduledJobs` (~line 432), replace `siteId: schedule.siteId,` in the `createEvalJob` call with:

```ts
            siteId: null,
            targetRegion: schedule.region,
            targetTier: schedule.targetTier,
```

- [ ] **Step 6: Restart server, run the test**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/tier-pool-dispatch.test.ts
npm run check
```

Expected: PASS; tsc clean on server/shared (client `schedule.siteId` consumers may error — Task 5's scope; report them).

- [ ] **Step 7: Commit**

```bash
git add server/routes.ts server/index.ts tests/tier-pool-dispatch.test.ts
git commit -m "feat(dispatch): run + schedule routes take region×targetTier pools

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: run-targets `tiers` block + dispatchable region

**Files:**
- Modify: `server/storage.ts` (`getEvalAgentsWithTokenTier` ~line 716 — add token region)
- Modify: `server/routes.ts` (run-targets handler ~4086–4114; dispatchable handler ~3049–3067)
- Test: extend `tests/tier-pool-dispatch.test.ts`

**Interfaces:**
- Consumes: `getEvalAgentsWithTokenTier` rows; `hasOrg`, `sameOrg`; the run route's session detection (already computed in the run-targets handler? NO — run-targets computes `referencedSecrets` via `classifyReferencedSecrets`; use that result's brokered entries to detect a session workflow: any referenced secret with `brokerType != null`).
- Produces: run-targets response `tiers: Array<{ tier: string; available: boolean; onlineAgents?: number; reason?: string }>`; `?region=` query param replaces `?siteId=`. Dispatchable `free` rows gain `region`.

- [ ] **Step 1: Write the failing test (extend `tests/tier-pool-dispatch.test.ts`)**

```ts
describe("run-targets tiers block", () => {
  let cookie: string; let workflowId: number; let evalSetId: number;
  beforeAll(async () => {
    cookie = await login();
    const wf = await (await authFetch(cookie, `${BASE_URL}/api/workflows?includePublic=true`)).json();
    workflowId = wf[0].id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;
  });

  it("advertises per-tier availability with online counts for the region", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run-targets?region=${BASE_NA}&evalSetId=${evalSetId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tiers)).toBe(true);
    const byTier = Object.fromEntries(body.tiers.map((t: any) => [t.tier, t]));
    expect(byTier.public.available).toBe(true);
    expect(typeof byTier.public.onlineAgents).toBe("number");
    expect(byTier.private.available).toBe(true);
    expect(byTier.team.available).toBe(false); // admin has no org in dev seed
    expect(byTier.team.reason).toBe("no-org");
    expect(byTier.shared.available).toBe(false);
    expect(byTier.shared.reason).toBe("not-pooled-yet");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/tier-pool-dispatch.test.ts` → FAIL (no `tiers`).

- [ ] **Step 3: Add `tokenRegion` to `getEvalAgentsWithTokenTier`**

In the select object add `tokenRegion: evalAgentTokens.region,` and widen the return type with `tokenRegion: string`.

- [ ] **Step 4: Implement the `tiers` block in the run-targets handler**

The handler already parses a region-ish query param (`req.query.siteId`) — rename to `req.query.region` (value is now a baseId; the `mine`/`shared` filters compare `regionOf`-style: `t.siteId` starts with the region — simplest: filter tokens by `t.region === region` once tokens carry region; for `shared` listings compare `regionOf(l.region)`… the seam's AgentSummary `region` field actually carries a SITE id from `setListing` — filter with `l.region.startsWith(region + "-")`). Then, after `referencedSecrets` is computed:

```ts
      const region = req.query.region ? String(req.query.region) : null;
      const needsSession = referencedSecrets.some((s: { brokerType: string | null }) => s.brokerType != null);
      const agents = await storage.getEvalAgentsWithTokenTier();
      const online = agents.filter((a) =>
        a.state !== "offline" && (!region || a.tokenRegion === region));
      const countFor = (tier: "private" | "team" | "public"): number =>
        online.filter((a) => {
          if (tier === "private") return a.tokenCreatedBy === user.id;
          if (tier === "team")
            return (a.tokenDispatchTier === "team" || a.tokenDispatchTier === "public")
              && sameOrg({ organizationId: user.organizationId }, { organizationId: a.tokenOwnerOrgId });
          return a.tokenDispatchTier === "public";
        }).length;
      const tiers = [
        { tier: "private", available: true, onlineAgents: countFor("private") },
        hasOrg(user)
          ? { tier: "team", available: true, onlineAgents: countFor("team") }
          : { tier: "team", available: false, reason: "no-org" },
        needsSession
          ? { tier: "public", available: false, reason: "session-injected" }
          : { tier: "public", available: true, onlineAgents: countFor("public") },
        { tier: "shared", available: false, reason: "not-pooled-yet" },
      ];
```

and include `tiers` in the response: `res.json({ agents: { mine, shared }, referencedSecrets, tiers });`

Check the actual property name on `referencedSecrets` entries before using it (`brokerType` per the secrets-class design; verify with the handler's `classifyReferencedSecrets` return type).

- [ ] **Step 5: Dispatchable free rows gain region**

In the dispatchable handler's `free` mapping add `region: a.tokenRegion` (the internal `rows` map feeding `filterDispatchableAgents` keeps its existing `region: a.siteId` DTO field — do NOT touch it; only the response map changes):

```ts
        free: free.map((a) => ({ tokenId: a.tokenId, siteId: a.region, region: regionRowByTokenId.get(a.tokenId) ?? null, dispatchTier: a.dispatchTier, state: a.state })),
```

Simplest implementation: build `const regionRowByTokenId = new Map(agents.map((a) => [a.tokenId, a.tokenRegion]));` from the `agents` array already fetched in that handler.

- [ ] **Step 6: Restart server, run tests, typecheck, commit**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/tier-pool-dispatch.test.ts
npm run check
git add server/routes.ts server/storage.ts tests/tier-pool-dispatch.test.ts
git commit -m "feat(dispatch): run-targets advertises tier availability; dispatchable rows carry region

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Client — selectors, display, schedules UI

**Files:**
- Modify: `client/src/pages/run-your-own.tsx` (region state ~81, run-targets query ~179–182, run body ~197, selector ~496–508, job display ~630, curl doc ~596)
- Modify: `client/src/pages/console-workflow-detail.tsx` (body ~103, selector ~186–228)
- Modify: `client/src/pages/console-evalsets.tsx` (run body ~132, schedule body ~152, their selectors)
- Modify: `client/src/pages/console-organization-settings.tsx` (`ScheduleItem.siteId` ~36, display ~331)
- Modify: `client/src/pages/console-eval-jobs.tsx` (job + schedule site display columns)
- Modify: `tests/e2e/run-your-own.spec.ts` (region-selector test)
- Test: `npm run check` + E2E spot-run

**Interfaces:**
- Consumes: `useRegionLocationOptions` from `client/src/hooks/use-regions.ts` (exists — baseId values, "Seattle, United States · North America" labels); `formatRegion`/`formatSite` from `client/src/lib/utils.ts`; Task 3 body contract; Task 4 `tiers` block.
- Produces: nothing downstream — this is the leaf.

- [ ] **Step 1: run-your-own selector**

Switch the region control from `useSiteOptions` to `useRegionLocationOptions` (state var `region` now holds a baseId). Add tier state and radio:

```tsx
  const [region, setRegion] = useState<string>("");
  const [targetTier, setTargetTier] = useState<string>("public");
```

Selector markup (replacing the current Target Region select's options source):

```tsx
                <div className="space-y-2">
                  <Label>Target Region</Label>
                  <Select value={region} onValueChange={setRegion}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a region" />
                    </SelectTrigger>
                    <SelectContent>
                      {regionOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Run on</Label>
                  <Select value={targetTier} onValueChange={setTargetTier}>
                    <SelectTrigger data-testid="select-target-tier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(runTargets?.tiers ?? []).filter((t) => t.tier !== "shared").map((t) => (
                        <SelectItem key={t.tier} value={t.tier} disabled={!t.available}>
                          {t.tier === "public" ? "Any public agent" : t.tier === "private" ? "My agents" : "Team agents"}
                          {t.available ? ` (${t.onlineAgents} online)` : t.reason === "no-org" ? " — join an organization" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(runTargets?.tiers ?? []).find((t) => t.tier === targetTier)?.onlineAgents === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No matching agent is online right now; the job will wait in the pool (up to 24h).
                    </p>
                  )}
                </div>
```

Run-targets query key/url: `?siteId=${region}` → `?region=${region}`. Run mutation body: `siteId: region` → `region, targetTier` (when no specific agent chosen; a chosen specific agent keeps sending `targetTokenId` only). The `tiers` type: extend the local `RunTargetsResponse` interface with `tiers: { tier: string; available: boolean; onlineAgents?: number; reason?: string }[]`. Update the curl doc example (~596) to `'{"region": "na-us-seattle", "targetTier": "public"}'`. Job status display (~630): where `job.siteId` renders, use `job.siteId ? formatSite(job.siteId) : \`${formatRegion(job.targetRegion ?? "")} · ${job.targetTier} pool\``; extend the local `EvalJob` interface with `siteId: string | null; targetRegion: string | null; targetTier: string | null`.

- [ ] **Step 2: console-workflow-detail + console-evalsets**

Same substitutions: `useSiteOptions` → `useRegionLocationOptions` for the run/schedule dialogs, `runRegion` holds a baseId, bodies send `region: runRegion, targetTier` (add a tier select identical in shape to Step 1's, minus the online counts if that dialog has no run-targets query — console-evalsets does not fetch run-targets: give it the plain three-option tier select with `team` disabled when the auth-status user has no `organizationId`). Schedule body (`console-evalsets.tsx` ~152) sends `region: runRegion, targetTier`.

- [ ] **Step 3: schedules + jobs display**

`console-organization-settings.tsx`: `ScheduleItem.siteId` → `region: string; targetTier: string`; display `formatRegion(item.region)` + tier. `console-eval-jobs.tsx`: schedule rows show `formatRegion(schedule.region)`; job rows show `job.siteId ? formatSite(job.siteId) : formatRegion(job.targetRegion ?? "")` with a tier badge when pooled (`job.targetTier`). Update the local Enriched* interfaces accordingly.

- [ ] **Step 4: E2E spec update**

In `tests/e2e/run-your-own.spec.ts`, replace the "should show region selector with site placeholder" test's placeholder assertion `text=Select a site` → `text=Select a region`, and add:

```ts
  test("should show Run on tier selector defaulting to public", async ({ page }) => {
    await expect(page.getByTestId("select-target-tier")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("select-target-tier")).toContainText(/Any public agent/);
  });
```

- [ ] **Step 5: Verify**

```bash
npm run check                       # must be FULLY clean now
npx playwright test tests/e2e/run-your-own.spec.ts
```

Expected: tsc zero errors; E2E green.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/run-your-own.tsx client/src/pages/console-workflow-detail.tsx client/src/pages/console-evalsets.tsx client/src/pages/console-organization-settings.tsx client/src/pages/console-eval-jobs.tsx tests/e2e/run-your-own.spec.ts
git commit -m "feat(console): region + tier pool selector across all dispatch surfaces

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: Test-suite migration, wire contract, full gate

**Files:**
- Modify: every test that still POSTs `siteId:` to `/run` or `/api/eval-schedules` — the sweep below
- Modify: `tests/site-id-wire.test.ts`
- Test: `./scripts/full-tests-run.sh`

**Interfaces:** consumes Task 3's body contract; produces the green gate.

- [ ] **Step 1: Sweep the suite's dispatch bodies**

Find them: `grep -rn "siteId: REGION_\|siteId: testAgentRegion\|siteId: flowAgentRegion\|siteId: agentRegion\|siteId: naRegion\|siteId: apacRegion\|siteId: euRegion\|siteId: concurrentRegion\|siteId: versionTestRegion\|siteId: legacyRegion\|siteId: freeTokenRegion\|siteId: 'invalid'\|siteId: region," tests/*.test.ts` — then, for each hit that is a **run or eval-schedules request body** (clash bodies also use `siteId:` — those routes are UNCHANGED, leave them; check the surrounding URL):

- Pool-region rule: the body needs a REGION, not a site. `siteId: REGION_NA` → `region: BASE_NA, targetTier: "public"`. A variable holding a token's site (e.g. `agentRegion = tokenData.siteId`) → derive `agentRegion.replace(/-\d+$/, "")` or capture `tokenData.region` at the source instead (preferred — the create response will carry `region` if Task 4's response includes it; otherwise strip the suffix at the call site).
- Tests whose CLAIM step uses the dispatcher's own registered agent (job-flow tests): use `targetTier: "public"` when the claiming token is public-tier (most fixtures), `"private"` when the test relies on the own-agent arm.
- Invalid-site tests (`siteId: 'invalid'` on run/schedules) → `region: 'invalid', targetTier: 'public'` (still 400, now via the region check).
- Assertions on the created job: `expect(job.siteId).toBe(...)` at creation-time → `expect(job.siteId).toBeNull()` + `expect(job.targetRegion).toBe(BASE_X)`; after a claim, `job.siteId` equals the claiming agent's site (assert `toContain(BASE_X)` when the exact sequence is unknown).
- `session-dispatch`/`session-capability-gate`/`secrets`* tests dispatch session workflows: use `targetTier: "private"` (public is now 403 for session workflows — that's the new contract; add one explicit assertion that `targetTier: "public"` + session workflow → 403 in `tests/session-dispatch.test.ts`).

- [ ] **Step 2: Extend `tests/site-id-wire.test.ts`**

Replace the `?siteId=` filter test's companion body test expectations and add the pool contract:

```ts
  it('run body takes region+targetTier; the siteId body key is dead', async () => {
    const wf = await (await authFetch('/api/workflows?includePublic=true')).json();
    const es = await (await authFetch('/api/eval-sets?includePublic=true')).json();
    const viaSite = await authFetch(`/api/workflows/${wf[0].id}/run`, {
      method: 'POST',
      body: JSON.stringify({ siteId: REGION_NA, evalSetId: es[0].id }),
    });
    expect(viaSite.status).toBe(400); // siteId body key no longer read

    const viaPool = await authFetch(`/api/workflows/${wf[0].id}/run`, {
      method: 'POST',
      body: JSON.stringify({ region: BASE_NA, targetTier: 'public', evalSetId: es[0].id }),
    });
    expect(viaPool.status).toBe(200);
    const { job } = await viaPool.json();
    expect(job.siteId).toBeNull();
    expect(job.targetRegion).toBe(BASE_NA);
  });
```

Import `BASE_NA` alongside `REGION_NA`. Keep the existing eval-jobs `?siteId=` FILTER test — the query filter is unchanged (it filters concrete claimed sites).

- [ ] **Step 3: Full unit suite**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
# pollution clean (Global Constraints), then:
set -a; source .env; source .env.dev; set +a
export DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox"
npm test
```

Expected: all green. Triage any failure into (a) missed body-sweep site → fix per Step 1 rules, (b) environment (daemon down / remote ConvoAI session lingering — restart daemon / wait 2 min and rerun the file), before touching product code.

- [ ] **Step 4: Full gate**

Run: `./scripts/full-tests-run.sh`
Expected: unit + audio + E2E all PASSED.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: migrate dispatch bodies to region×targetTier pools; pin the wire contract

🤖 Built with SMT <smt@agora.build>"
```

---

## Post-plan notes for the controller

- **Daemon impact: none.** `vox_eval_agentd/vox-agentd.ts` consumes the jobs listing and claims by id; job rows gain `targetRegion`/`targetTier` (ignored) and `siteId` is non-null by claim time (the daemon reads it post-claim if at all). The register/heartbeat flow is untouched. If daemon tests reference job `siteId` pre-claim, Task 6 triages them.
- **OpenAPI**: `docs/openapi.yaml` documents the v1 API; the run/schedules session routes are not in it (verified during the alias-drop cycle — zero `region` matches). If Task 6's grep finds v1 doc entries for run bodies, update them to `region`+`targetTier`.
- **Deploy**: migration 0034 applies on Coolify startup. It is **one-way** (drops `eval_schedules.site_id`); review the SQL before merge per the migration rule. Deployed eval-agentd fleet is already compatible (no wire change).
