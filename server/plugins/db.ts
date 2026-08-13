import type { Pool, PoolClient } from "pg";
import type { PluginDb } from "@vox/plugin-sdk";

export function schemaForPlugin(id: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`invalid plugin id: ${id}`);
  }
  return "plugin_" + id.replace(/-/g, "_");
}

export function createPluginDb(pool: Pool, schema: string): PluginDb {
  const onClient = <T>(sql: string, params: unknown[] | undefined, client: PoolClient) =>
    client.query(sql, params).then((r) => ({ rows: r.rows as T[] }));

  return {
    schema,
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const client = await pool.connect();
      let releaseErr: Error | undefined;
      try {
        await client.query("BEGIN");
        // SET LOCAL (transaction-scoped): auto-reset at COMMIT/ROLLBACK so the
        // plugin's search_path never leaks onto the shared pooled connection.
        // Plain SET persists past COMMIT and would silently rewrite search_path
        // for the next unrelated pool.query() (e.g. Core storage queries).
        // "public" is included so shared/core tables still resolve; the plugin
        // schema takes precedence for the plugin's own unqualified names.
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        const result = await onClient<T>(sql, params, client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          releaseErr = rollbackErr as Error;
          console.error(`[plugin-db] ROLLBACK failed for schema ${schema}:`, rollbackErr);
        }
        throw err;
      } finally {
        client.release(releaseErr);
      }
    },
    async withTransaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let releaseErr: Error | undefined;
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        const tx: PluginDb = {
          schema,
          query: <U = unknown>(sql: string, params?: unknown[]) => onClient<U>(sql, params, client),
          withTransaction: () => { throw new Error("nested withTransaction is not supported"); },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // If ROLLBACK itself fails the connection is in an unknown state:
        // swallow+log its error so it can't mask the original, and mark the
        // client tainted so the pool destroys it instead of recycling it.
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          releaseErr = rollbackErr as Error;
          console.error(`[plugin-db] ROLLBACK failed for schema ${schema}:`, rollbackErr);
        }
        throw err;
      } finally {
        client.release(releaseErr);
      }
    },
  };
}
