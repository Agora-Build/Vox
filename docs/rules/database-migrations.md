# Database Migration Rules

Vox uses a version-based migration system defined in `server/migrate.ts`. Every deploy runs migrations automatically before the server starts.

## How it works

- `_schema_version` table stores one row: the current schema version integer
- `server/migrate.ts` defines a `MIGRATIONS` list — one entry per version, pointing to a SQL file
- On startup: compare DB version vs `TARGET_VERSION`; run any missing steps in order
- Ordinary steps run in a **transaction** — SQL + version update are atomic
- Explicit `concurrentIndex` steps build a single-column B-tree index outside a transaction, then commit the version atomically. This avoids blocking ingestion writes on a large history table.
- A session advisory lock prevents concurrent migrations across multiple instances (one runs, others poll)
- If migration fails: rollback, `process.exit(1)`, container stops — server never starts with a broken schema

## Startup entry point

Both `npm start` (used by Coolify) and the Dockerfile `CMD` run migrations first:

```
node dist/migrate.cjs && node dist/index.cjs
```

`migrate.cjs` exits 0 → server starts. Exits 1 → server never starts.

## Multi-instance safety

When multiple instances start simultaneously:
1. All poll `pg_try_advisory_lock(987654321)` — one gets it, others retry every 250 ms without holding a snapshot that could deadlock a concurrent index build
2. First instance runs migrations, updates version, releases lock
3. Remaining instances acquire lock one by one, see version is current, skip immediately
4. All instances start normally

## Full upgrade process

1. **Edit `shared/schema.ts`** — add tables, columns, enums, etc.

2. **Generate SQL:**
   ```bash
   DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:generate
   ```
   Review the generated file in `migrations/` — confirm it only changes what you intended.

3. **Register in `server/migrate.ts`** — append one line:
   ```typescript
   { version: 3, description: "your feature", file: "0002_your_tag.sql" },
   ```
   `TARGET_VERSION` is always the last entry's version number.

4. **Commit all three files together:**
   ```bash
   git add shared/schema.ts migrations/0002_your_tag.sql server/migrate.ts
   git commit -m "feat: <description>"
   git push origin main
   ```

5. **Deploy runs automatically** — Coolify triggers on push, runs `npm start`, migrations apply before server starts.

## Version behavior

| DB state | What happens |
|----------|-------------|
| Fresh DB (no tables) | Runs all migrations from v1 upward |
| Existing DB, no `_schema_version`, `users` table present | Bootstraps to v1, runs v2+ |
| Already at current version | No-op — "Schema is up to date" |
| Migration fails | Rollback, container stops, server never starts |
| Multiple instances starting simultaneously | One migrates, others wait, all start after |

## Rules

- **Never modify an existing MIGRATIONS entry** — append only
- **Never skip version numbers** — increment by 1 each time
- **Always commit SQL file and MIGRATIONS entry together** — they must stay in sync
- **Keep SQL clean** — plain `CREATE TABLE`, `ALTER TABLE`. No `IF NOT EXISTS`, no `DO...EXCEPTION`
- **Concurrent indexes:** register `concurrentIndex: { name, table, column }` and use exactly `CREATE INDEX CONCURRENTLY <name> ON public.<table> (<column>);`. The runner holds one connection's advisory lock through the build and version commit. A retry reuses a matching valid index, drops/rebuilds a matching invalid index, and refuses an unexpected definition. Do not combine other SQL with this step; ordinary migrations remain transactional.
- **Never use `db:push` or `drizzle-kit push --force` in production** — diffs live schema, may drop columns silently

## Emergency: apply without redeploy

```bash
# Coolify → application → terminal:
DATABASE_URL=<prod-url> node dist/migrate.cjs
```
