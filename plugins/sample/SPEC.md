# sample — Plugin Spec

## Identity
- id: `sample`
- version: 1.0.0
- voxPluginApi: ^1.0.0

## Function and non-goals
A minimal reference plugin proving the platform: routes, a migration, a singleton
worker, a health check, and a provided service. Not a product feature; it is the
copy-paste template for real plugins.

## Services provided and consumed
- Provides: `vox.sample@1.0.0` — `{ count(): Promise<number> }`
- Consumes: none

## HTTP and WebSocket URLs
- `GET /api/plugins/sample/notes` — list latest notes (requireAuth)
- `POST /api/plugins/sample/notes` — create a note (requireAuth)

## Web UI contributions
None (backend-only in this slice).

## Dependencies and minimum versions
None.

## Environment variables
None.

## Database configuration
- Schema: `plugin_sample`
- Tables: `notes`

## Data ownership
Owns `plugin_sample.notes`. References no Core tables.

## Permissions
Both routes require an authenticated user (Core `requireAuth`).

## Workers
- `prune` — singleton, every 60s, deletes notes older than 30 days.

## Enablement and disabled behavior
Enabled via `VOX_PLUGINS=sample`. When disabled, its routes and data are
inaccessible; tables are retained (forward-only).

## Migrations and upgrades
- `migrations/0001_init.sql` — creates `notes`. Forward-only, checksum-frozen.

## Health and operations
- `GET /api/plugins/sample/health` — `ok` when the database responds.

## Security and data retention
Note bodies are truncated to 500 chars and pruned after 30 days.

## Failure modes
DB unavailable → health `down`; routes return 500 via Core error handling.

## Drain procedure
Stateless beyond `notes`; drain is a no-op (no in-flight external work).
