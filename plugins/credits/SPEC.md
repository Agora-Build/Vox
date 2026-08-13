# credits — Plugin Spec

## Identity
- id: `credits`
- version: 1.0.0
- voxPluginApi: ^1.0.0

## Function and non-goals
A standalone, closed-loop, spend-only credit ledger. Double-entry append-only
ledger with cached balances; escrow hold/capture/release lifecycle for future
marketplace settlement; admin grant as the standalone credit-in path. Non-goals:
payments/Stripe (a separate downstream plugin consumes `vox.credits`), cash-out,
shared-agents dispatch (cycle 2), multi-currency, fractional credits.

## Services provided and consumed
- Provides: `vox.credits@1.0.0` — `{ getBalance, deposit, hold, capture, release, getStatement }`.
- Consumes: none. Credits depends on no other plugin and functions fully alone.

## HTTP and WebSocket URLs
- `GET /api/plugins/credits/balance` — caller's balance (requireAuth).
- `GET /api/plugins/credits/statement` — caller's ledger, newest-first, keyset-paginated (requireAuth).
- `POST /api/plugins/credits/grants` — admin credit-in via `deposit` (requireAdmin).
- `GET /api/plugins/credits/accounts` — admin account/hold inspection (requireAdmin).
Escrow (hold/capture/release) is service-only and intentionally has no HTTP route.

## Web UI contributions
None (backend-only in this slice).

## Dependencies and minimum versions
None.

## Environment variables
None.

## Database configuration
- Schema: `plugin_credits`
- Tables: `accounts`, `ledger_entries`, `credit_holds`, `idempotency_keys`

## Data ownership
Owns all `plugin_credits` tables. References no Core tables; `accounts.user_ref`
is an opaque Core `users.id`, not a foreign key.

## Permissions
Read routes require the authenticated caller and act only on that caller's own
account. Grant and account-inspection routes require a Core admin.

## Workers
- `reconcile` — singleton, every ~5 min, read-only. Verifies ledger invariants
  (per-account balance == Σ entries; global Σ == 0; no stale/leaked holds) and
  drives the health status. Never mutates balances.

## Enablement and disabled behavior
Enabled via `VOX_PLUGINS=credits`. When disabled, routes and data are
inaccessible; tables are retained (forward-only).

## Migrations and upgrades
- `migrations/0001_init.sql` — creates the four tables and seeds the `external`,
  `escrow`, `platform` system accounts. Forward-only, checksum-frozen.

## Health and operations
- `GET /api/plugins/credits/health` — `ok` when the DB responds and the last
  reconcile pass found zero invariant violations; `degraded` (with the broken
  invariant named) otherwise; `down` when the DB is unreachable.

## Security and data retention
Ledger entries are immutable and retained indefinitely (audit trail). No secrets
stored. `deposit`/`hold` are idempotent by caller key; `capture`/`release` are
idempotent by hold status.

## Failure modes
DB unavailable → health `down`, routes 500 via Core error handling. Invariant
drift → health `degraded`, structured error log; balances are never auto-corrected.

## Drain procedure
No in-flight external work; drain is a no-op. Held escrow (once cycle-2 creates
any) is settled by the consumer plugin, not by credits.
