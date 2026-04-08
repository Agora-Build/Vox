# Database Migration Rules

Vox uses a version-based migration system defined in `server/migrate.ts`. Every deploy runs migrations automatically before the server starts.

## How it works

- `_schema_version` table stores one row: the current schema version integer
- `server/migrate.ts` defines a `MIGRATIONS` list — one entry per version
- On startup: compare DB version vs `TARGET_VERSION`; run any missing steps in order
- Each step runs in a **transaction** — SQL + version update are atomic
- `pg_advisory_lock` prevents two containers from migrating simultaneously
- If migration fails: rollback, `process.exit(1)`, container stops (server never starts)

## Adding a new migration

1. Modify `shared/schema.ts`
2. Generate the SQL file:
   ```bash
   DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:generate
   ```
3. Review the generated SQL in `migrations/` — confirm it only changes what you intended
4. Append one entry to `MIGRATIONS` in `server/migrate.ts`:
   ```typescript
   { version: 3, description: "your feature", file: "0002_your_file.sql" },
   ```
   `TARGET_VERSION` updates automatically (last entry's version number).
5. Commit `shared/schema.ts`, the new migration file, and `server/migrate.ts` together
6. Push → migration runs automatically on next deploy

## Version behavior

| DB state | What happens |
|----------|-------------|
| Fresh DB (no tables) | Runs all migrations from v1 upward |
| Existing DB, no version record, `users` table present | Bootstraps to v1, runs v2+ |
| Already at current version | No-op ("Schema is up to date") |
| Migration fails | Rollback, container stops, server never starts |

## Rules

- **Never modify an existing MIGRATIONS entry** — only append new ones
- **Never skip version numbers** — increment by 1 each time
- **Always commit SQL file and MIGRATIONS entry together** — they must match
- **Keep SQL clean** — plain `CREATE TABLE`, `ALTER TABLE`. No `IF NOT EXISTS`, no `DO...EXCEPTION`
- **Never use `db:push` or `drizzle-kit push --force` in production** — destroys columns silently

## Emergency: apply without redeploy

```bash
# In Coolify → application → terminal:
DATABASE_URL=<prod-url> node dist/migrate.cjs
```
