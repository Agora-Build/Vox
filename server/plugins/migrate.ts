import { readdir, readFile } from "fs/promises";
import { createHash } from "crypto";
import type { Pool } from "pg";
import type { PluginManifest } from "./manifest";
import { schemaForPlugin } from "./db";

const PLUGIN_MIGRATION_LOCK_ID = 987654322;

export async function runPluginMigrations(
  pool: Pool,
  manifests: PluginManifest[],
  pluginsDir = "./plugins",
): Promise<void> {
  // Session-scoped advisory lock: it MUST be acquired and released on the SAME
  // pooled connection, so we hold one dedicated client for the whole run.
  // (pool.query() grabs a different client per call, which would leak/deadlock
  // the lock.) This serializes migrations so two app instances cannot double-run.
  const lockClient = await pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock($1)`, [PLUGIN_MIGRATION_LOCK_ID]);
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS _plugin_schema_versions (
          plugin_id  text    NOT NULL,
          version    integer NOT NULL,
          checksum   text    NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (plugin_id, version)
        )`);

      for (const m of manifests) {
        const schema = schemaForPlugin(m.id);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const dir = `${pluginsDir}/${m.id}/${m.migrations ?? "migrations"}`;
        let files: string[];
        try {
          files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
        } catch {
          continue; // no migrations directory for this plugin
        }

        const { rows } = await pool.query(
          `SELECT version, checksum FROM _plugin_schema_versions WHERE plugin_id = $1`, [m.id]);
        const applied = new Map<number, string>(rows.map((r) => [r.version as number, r.checksum as string]));

        for (const file of files) {
          const version = parseInt(file.slice(0, 4), 10);
          if (Number.isNaN(version)) {
            throw new Error(`plugin ${m.id}: migration file must start with NNNN: ${file}`);
          }
          const contents = await readFile(`${dir}/${file}`, "utf-8");
          const checksum = createHash("sha256").update(contents).digest("hex");

          if (applied.has(version)) {
            if (applied.get(version) !== checksum) {
              throw new Error(`plugin ${m.id} migration ${file} changed after release (checksum mismatch)`);
            }
            continue;
          }

          const statements = contents.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
          const client = await pool.connect();
          let releaseErr: Error | undefined;
          try {
            await client.query("BEGIN");
            // SET LOCAL (not plain SET): scopes the search_path change to
            // this transaction only, so it's automatically undone at
            // COMMIT/ROLLBACK. Plain SET persists on the underlying pooled
            // connection past the commit — the next unrelated pool.query()
            // to grab this same connection would silently inherit it and
            // resolve unqualified names (like _plugin_schema_versions) into
            // the wrong schema. Also include "public" so the unqualified
            // _plugin_schema_versions bookkeeping INSERT below still
            // resolves — the plugin's own schema still comes first for the
            // migration's own (unqualified) statements.
            await client.query(`SET LOCAL search_path TO "${schema}", public`);
            for (const statement of statements) await client.query(statement);
            await client.query(
              `INSERT INTO _plugin_schema_versions (plugin_id, version, checksum) VALUES ($1, $2, $3)`,
              [m.id, version, checksum]);
            await client.query("COMMIT");
          } catch (err) {
            try {
              await client.query("ROLLBACK");
            } catch (rollbackErr) {
              releaseErr = rollbackErr as Error;
              console.error(`[plugin-migrate] ROLLBACK failed for ${m.id} ${file}:`, rollbackErr);
            }
            throw err;
          } finally {
            client.release(releaseErr);
          }
        }
      }
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock($1)`, [PLUGIN_MIGRATION_LOCK_ID]);
    }
  } finally {
    lockClient.release();
  }
}
