import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { acquireMigrationLock, applyMigrationStep } from "../server/migration-step";

const concurrentIndex = { name: "eval_results_created_at_idx", table: "eval_results", column: "created_at" };
const sql = readFileSync("migrations/0051_metrics_time_index.sql", "utf8");
const definition = "CREATE INDEX eval_results_created_at_idx ON public.eval_results USING btree (created_at)";
const migration = { version: 52, statements: [sql], concurrentIndex };
const valid = { valid: true, ready: true, definition };

function mockClient(states: unknown[][] = []) {
  const query = vi.fn(async (statement: string) => ({
    rows: statement.includes("FROM pg_index") ? (states.shift() ?? []) : [],
  }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("migration steps", () => {
  it("polls a nonblocking session lock so a waiting runner does not retain a snapshot", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValueOnce({ rows: [{ locked: true }] });
    await acquireMigrationLock({ query } as unknown as PoolClient, 987654321);
    expect(query.mock.calls).toEqual([
      ["SELECT pg_try_advisory_lock($1) AS locked", [987654321]],
      ["SELECT pg_try_advisory_lock($1) AS locked", [987654321]],
    ]);
  });

  it("keeps ordinary SQL and the version update in one transaction", async () => {
    const { client, query } = mockClient();
    await applyMigrationStep(client, { version: 51, statements: ["ALTER TABLE example ADD COLUMN value int"] });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN", "ALTER TABLE example ADD COLUMN value int", "DELETE FROM _schema_version",
      "INSERT INTO _schema_version (version) VALUES ($1)", "COMMIT",
    ]);
    expect(query).toHaveBeenCalledWith("INSERT INTO _schema_version (version) VALUES ($1)", [51]);
  });

  it("rolls back ordinary migration failures without stamping a version", async () => {
    const { client, query } = mockClient();
    query.mockRejectedValueOnce(new Error("begin failed"));
    await expect(applyMigrationStep(client, { version: 51, statements: ["SQL"] })).rejects.toThrow("begin failed");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    query.mockClear();
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("SQL failed"));
    await expect(applyMigrationStep(client, { version: 51, statements: ["SQL"] })).rejects.toThrow("SQL failed");
    expect(query.mock.calls.map(([statement]) => statement)).toEqual(["BEGIN", "SQL", "ROLLBACK"]);
  });

  it("builds and verifies an index before beginning the version transaction", async () => {
    const { client, query } = mockClient([[], [valid]]);
    await applyMigrationStep(client, migration);
    const calls = query.mock.calls.map(([statement]) => statement);
    expect(calls.indexOf(sql)).toBeLessThan(calls.indexOf("BEGIN"));
    expect(calls.filter(statement => statement.includes("FROM pg_index"))).toHaveLength(2);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("reuses a matching valid index after a crash before version commit", async () => {
    const { client, query } = mockClient([[valid]]);
    await applyMigrationStep(client, migration);
    expect(query).not.toHaveBeenCalledWith(sql);
    expect(query).not.toHaveBeenCalledWith("DROP INDEX CONCURRENTLY public.eval_results_created_at_idx");
    expect(query).toHaveBeenCalledWith("INSERT INTO _schema_version (version) VALUES ($1)", [52]);
  });

  it("drops and rebuilds only a matching invalid index after an interrupted build", async () => {
    const { client, query } = mockClient([[{ ...valid, valid: false }], [valid]]);
    await applyMigrationStep(client, migration);
    const calls = query.mock.calls.map(([statement]) => statement);
    expect(calls.indexOf("DROP INDEX CONCURRENTLY public.eval_results_created_at_idx")).toBeLessThan(calls.indexOf(sql));
    expect(calls.indexOf(sql)).toBeLessThan(calls.indexOf("BEGIN"));
  });

  it("refuses to replace a same-name index with a different definition", async () => {
    const { client, query } = mockClient([[{ ...valid, definition: definition.replace("created_at)", "id)") }]]);
    await expect(applyMigrationStep(client, migration)).rejects.toThrow("unexpected definition");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not stamp a version when an index build fails or is unusable", async () => {
    const { client, query } = mockClient([[], [{ ...valid, valid: false }]]);
    await expect(applyMigrationStep(client, migration)).rejects.toThrow("not usable");
    expect(query).not.toHaveBeenCalledWith("BEGIN");
  });

  it("rolls back a failed version update while retaining the reusable built index", async () => {
    const { client, query } = mockClient([[], [valid]]);
    query.mockImplementation(async statement => {
      if (statement.startsWith("INSERT INTO _schema_version")) throw new Error("version write failed");
      return { rows: statement.includes("FROM pg_index") ? [valid] : [] };
    });
    await expect(applyMigrationStep(client, migration)).rejects.toThrow("version write failed");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("refuses arbitrary nontransactional SQL or extra statements", async () => {
    const { client, query } = mockClient();
    for (const statements of [["DROP TABLE eval_results"], [sql, "SELECT 1"]]) {
      await expect(applyMigrationStep(client, { ...migration, statements })).rejects.toThrow("registered definition");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unsafe index identifiers before querying", async () => {
    const { client, query } = mockClient();
    await expect(applyMigrationStep(client, {
      ...migration, concurrentIndex: { ...concurrentIndex, name: "index; DROP TABLE eval_results" },
    })).rejects.toThrow("Invalid concurrent index identifier");
    expect(query).not.toHaveBeenCalled();
  });
});

// Explicitly opt in with a disposable database, never the shared application DATABASE_URL.
const testUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.startsWith("/vox_migration_test_")) {
  throw new Error("MIGRATION_TEST_DATABASE_URL must name a disposable vox_migration_test_* database");
}

describe.skipIf(!testUrl)("concurrent migration (isolated PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testUrl });
    client = await pool.connect();
    await client.query("CREATE TABLE _schema_version (version int NOT NULL)");
    await client.query("CREATE TABLE eval_results (id serial PRIMARY KEY, created_at timestamp NOT NULL DEFAULT now())");
  });
  beforeEach(async () => {
    await client.query("DROP INDEX IF EXISTS eval_results_created_at_idx");
    await client.query("DELETE FROM _schema_version");
    await client.query("INSERT INTO _schema_version VALUES (51)");
  });
  afterAll(async () => {
    await client.query("DROP TABLE eval_results, _schema_version");
    client.release();
    await pool.end();
  });

  async function indexState() {
    const { rows } = await client.query("SELECT indexrelid::int AS id, indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('eval_results_created_at_idx')");
    return rows[0];
  }
  async function version() {
    return (await client.query("SELECT version FROM _schema_version")).rows[0].version;
  }
  async function waitForBuild(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query("SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1", [pid]);
      if (rows[0]?.phase === "waiting for writers before build") return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Index builder did not reach the writer wait phase");
  }

  it("allows new ingestion writes while the index builder waits on an old writer", async () => {
    const writer = await pool.connect();
    const builder = await pool.connect();
    let build: Promise<void> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO eval_results DEFAULT VALUES");
      const pid = (await builder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      build = applyMigrationStep(builder, migration);
      void build.catch(() => {});
      await waitForBuild(pid);
      await client.query("SET statement_timeout = '1s'");
      await client.query("INSERT INTO eval_results DEFAULT VALUES");
      await writer.query("COMMIT");
      await build;
      expect(await version()).toBe(52);
      expect((await indexState()).valid).toBe(true);
    } finally {
      await writer.query("ROLLBACK");
      await build?.catch(() => {});
      await client.query("RESET statement_timeout");
      writer.release();
      builder.release();
    }
  });

  it("reuses a completed index when its version has not yet been committed", async () => {
    await client.query(sql);
    const oldId = (await indexState()).id;
    await applyMigrationStep(client, migration);
    expect((await indexState()).id).toBe(oldId);
    expect(await version()).toBe(52);
  });

  it("does not deadlock a concurrent index build with another runner waiting on its lock", async () => {
    const holder = await pool.connect();
    const waiter = await pool.connect();
    let waiting: Promise<void> | undefined;
    try {
      await acquireMigrationLock(holder, 987654321);
      waiting = acquireMigrationLock(waiter, 987654321);
      await new Promise(resolve => setTimeout(resolve, 50));
      await holder.query("SET statement_timeout = '2s'");
      await applyMigrationStep(holder, migration);
      await holder.query("SELECT pg_advisory_unlock($1)", [987654321]);
      await waiting;
      expect(await version()).toBe(52);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [987654321]);
      await waiting;
      await waiter.query("SELECT pg_advisory_unlock($1)", [987654321]);
      holder.release();
      waiter.release();
    }
  });

  it("recovers the invalid index left by a canceled concurrent build", async () => {
    const writer = await pool.connect();
    const builder = await pool.connect();
    let build: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO eval_results DEFAULT VALUES");
      const pid = (await builder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      build = applyMigrationStep(builder, migration).catch(error => error);
      await waitForBuild(pid);
      await client.query("SELECT pg_cancel_backend($1)", [pid]);
      expect(await build).toBeInstanceOf(Error);
      expect((await indexState()).valid).toBe(false);
      expect(await version()).toBe(51);
      await writer.query("COMMIT");
      await applyMigrationStep(client, migration);
      expect((await indexState()).valid).toBe(true);
      expect(await version()).toBe(52);
    } finally {
      await writer.query("ROLLBACK");
      await build;
      writer.release();
      builder.release();
    }
  });

  it("fails closed for a same-name index on the wrong column", async () => {
    await client.query("CREATE INDEX eval_results_created_at_idx ON eval_results (id)");
    const oldId = (await indexState()).id;
    await expect(applyMigrationStep(client, migration)).rejects.toThrow("unexpected definition");
    expect((await indexState()).id).toBe(oldId);
    expect(await version()).toBe(51);
  });

  it("retries safely after a version transaction failure", async () => {
    await client.query("ALTER TABLE _schema_version ADD CONSTRAINT test_version_guard CHECK (version < 52)");
    try {
      await expect(applyMigrationStep(client, migration)).rejects.toThrow();
      expect(await version()).toBe(51);
      expect((await indexState()).valid).toBe(true);
    } finally {
      await client.query("ALTER TABLE _schema_version DROP CONSTRAINT test_version_guard");
    }
    const oldId = (await indexState()).id;
    await applyMigrationStep(client, migration);
    expect((await indexState()).id).toBe(oldId);
    expect(await version()).toBe(52);
  });
});
