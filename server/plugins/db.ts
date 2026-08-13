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
      try {
        await client.query(`SET search_path TO "${schema}"`);
        return await onClient<T>(sql, params, client);
      } finally {
        client.release();
      }
    },
    async withTransaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET search_path TO "${schema}"`);
        const tx: PluginDb = {
          schema,
          query: <U = unknown>(sql: string, params?: unknown[]) => onClient<U>(sql, params, client),
          withTransaction: () => { throw new Error("nested withTransaction is not supported"); },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
