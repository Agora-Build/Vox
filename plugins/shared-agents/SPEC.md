# shared-agents — Plugin Spec

## Identity
- id: `shared-agents`
- version: 1.0.0
- voxPluginApi: ^1.0.0

## Function and non-goals
A marketplace that lets an agent owner list an eval-agent token for rent and lets
another user dispatch an eval job to it, with the renter's credits held in escrow
and settled by the job's outcome. Settlement is artifact-gated: escrow is captured
(paying the owner minus a platform fee) only when the rented agent's job completes
AND produces a real eval-result; a completed-but-empty self-report or a failed job
refunds. A singleton leak-reaper releases holds for settlements stuck pending past
a TTL. Non-goals: pricing beyond Phase B flat per-unit, an HTTP surface (Core
drives dispatch through the provided service, not a plugin route), credit-in/cash-out
(owned by `vox.credits`), and untargeted/auto shared routing.

## Services provided and consumed
- Provides: `vox.eval-marketplace@1.0.0` — `{ setListing, listDispatchable, authorizeDispatch, settle, voidDispatch, reapLeaks, countStuckPending }`.
- Consumes: `vox.credits@^1.0.0` — the escrow slice `{ hold, capture, release }` (duck-typed `CreditsPort`; no import from the credits package).

## HTTP and WebSocket URLs
None. The marketplace is consumed by Core's dispatch seam (`server/marketplace.ts`)
through the `vox.eval-marketplace` service, not exposed as plugin HTTP routes
(manifest `routes` is empty). The generic health route below is provided by the
Core plugin-health host, not declared by this plugin.

## Web UI contributions
None (backend-only in this slice).

## Dependencies and minimum versions
- `vox.credits` `^1.0.0` — **required**. It is resolved at activation via
  `services.require`; if credits is absent or version-incompatible the server
  fails to start (no degraded mode). credits must be enabled and ordered before
  shared-agents (the loader's topological sort guarantees this).

## Environment variables
None.

## Database configuration
- Schema: `plugin_shared_agents`
- Tables: `listings`, `settlements`

## Data ownership
Owns all `plugin_shared_agents` tables. References no Core tables; `token_id`,
`owner_id`, `payer_user_id`, and `earner_user_id` are opaque Core ids, not foreign
keys. Escrow lives in `vox.credits` (a `hold_id` links a settlement to its hold);
this plugin never reads credits' tables directly, only through the service.

## Permissions
No direct routes, so no route-level auth. Authorization is enforced by Core at the
dispatch seam: Core calls `authorizeDispatch(userId, tokenId, jobContext)` with the
acting user, and the marketplace refuses a dispatch whose token is not an active
listing (`not-for-sale`) or whose payer lacks credits (`insufficient-credits`).

## Workers
- `leak-reaper` — singleton, every 5 min. Releases escrow holds for settlements
  stuck `pending` past a 26h TTL (chosen `> max legitimate job lifetime`: 24h
  pending + 90m run), up to 200 per sweep. Each release uses the settle lock
  discipline (guard under a short lock, release the lock before the credits call,
  finalize under a fresh lock re-guarding on `pending`) so it never holds a pooled
  connection across a credits call.

## Enablement and disabled behavior
Enabled via `VOX_PLUGINS=shared-agents` (with `credits` also enabled). When
disabled, the `vox.eval-marketplace` service is absent and Core falls back to
non-marketplace dispatch; tables are retained (forward-only).

## Migrations and upgrades
- `migrations/0001_init.sql` — creates `listings` (one active listing per token)
  and `settlements` (the escrow/outcome record: `hold_id`, charge/fee split,
  `artifact_valid`, `status` in `pending|settled|refunded`, `void_reason`).
  Forward-only, checksum-frozen.

## Health and operations
- `GET /api/plugins/shared-agents/health` — `ok` when the DB responds and no
  settlement is stuck `pending` past the TTL; `degraded` (with the stuck count) when
  escrow-holding settlements are stuck past TTL; `down` when the DB is unreachable.

## Security and data retention
A terminal settlement (`settled`/`refunded`) is never rewritten; all state
transitions re-guard on `pending` for idempotency. Escrow ops are idempotent:
`hold` by settlement id (its `idempotencyKey`), `capture`/`release` by hold status.
No secrets stored. The artifact gate (`captured = completed && hasResult`) is the
money-relevant invariant — a renter never pays for a measurement they did not get.

## Failure modes
- credits missing/incompatible at boot → fail-fast startup (required service).
- `insufficient-credits` at hold → dispatch refused; the pending settlement is
  voided (credits threw before inserting a hold, so no escrow leaks).
- Unknown hold state (DB/connection error after hold may have committed) → the
  settlement is left `pending` and unmarked so credits' reconcile surfaces the
  orphaned hold; `countStuckPending` ignores hold-less rows so health does not flap.

## Drain procedure
In-flight escrow is settled by `settle`/`voidDispatch` on job terminal states and
by the leak-reaper backstop; drain is ready when no settlement holds escrow
(`countStuckPending` at 0). No other in-flight external work.
