import type { PoolClient } from "pg";

export interface ConcurrentIndex {
  name: string;
  table: string;
  column: string;
}

type MigrationClient = Pick<PoolClient, "query">;

export async function acquireMigrationLock(client: MigrationClient, lockId: number): Promise<void> {
  // A blocking pg_advisory_lock query holds a snapshot that CREATE INDEX CONCURRENTLY
  // may need to drain, deadlocking with the lock holder. Poll in short autocommit queries.
  while (true) {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
    if (rows[0].locked) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function buildConcurrentIndex(client: MigrationClient, statements: string[], index: ConcurrentIndex): Promise<void> {
  for (const identifier of [index.name, index.table, index.column]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Invalid concurrent index identifier");
  }
  const expectedSql = `CREATE INDEX CONCURRENTLY ${index.name} ON public.${index.table} (${index.column});`;
  const sql = statements[0]?.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  // Only this recoverable, single-column index operation may run outside a transaction.
  if (statements.length !== 1 || sql !== expectedSql) throw new Error("Concurrent index migration must match its registered definition");

  const expectedDefinition = `CREATE INDEX ${index.name} ON public.${index.table} USING btree (${index.column})`;
  const readState = async () => {
    const { rows } = await client.query<{ valid: boolean; ready: boolean; definition: string }>(
      `SELECT indisvalid AS valid, indisready AS ready, pg_get_indexdef(indexrelid) AS definition
       FROM pg_index WHERE indexrelid = to_regclass($1)`, [`public.${index.name}`]);
    const state = rows[0];
    if (state && state.definition !== expectedDefinition) throw new Error(`Existing index ${index.name} has an unexpected definition`);
    return state;
  };

  const existing = await readState();
  if (existing?.valid && existing.ready) return;
  // An interrupted concurrent build leaves an invalid index; remove only the matching index.
  if (existing) await client.query(`DROP INDEX CONCURRENTLY public.${index.name}`);
  await client.query(statements[0]);
  const built = await readState();
  if (!built?.valid || !built.ready) throw new Error(`Concurrent index ${index.name} is not usable`);
}

export async function applyMigrationStep(client: MigrationClient, migration: {
  version: number;
  statements: string[];
  concurrentIndex?: ConcurrentIndex;
}): Promise<void> {
  // Hold the runner's session advisory lock throughout both the build and the version update.
  // A completed build is reusable if the process dies before the version transaction commits.
  if (migration.concurrentIndex) await buildConcurrentIndex(client, migration.statements, migration.concurrentIndex);

  await client.query("BEGIN");
  try {
    if (!migration.concurrentIndex) {
      for (const statement of migration.statements) await client.query(statement);
    }
    await client.query("DELETE FROM _schema_version");
    await client.query("INSERT INTO _schema_version (version) VALUES ($1)", [migration.version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
