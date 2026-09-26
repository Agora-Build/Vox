import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { pool, validateEvalflowConfig } from "../server/storage";

/**
 * Migration 0040 (unified steps model) — executes the REAL migration file
 * against fixture rows inside a rolled-back transaction, so the SQL that
 * ships is the SQL that's proven:
 *  - a phone row with phoneDial and no steps converts to the exact-parity
 *    step form, and the converted config passes phone validation;
 *  - a web row keeps its authored steps and only loses the dead key;
 *  - a phone row that already has steps keeps them (authored wins);
 *  - a malformed number never reaches the YAML template (key-drop only);
 *  - whitespace-only step fields count as absent (the number is preserved).
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("migration 0040_steps_model.sql (transactional, rolled back)", () => {
  const stamp = `mig0040-${Date.now()}`;
  let client: import("pg").PoolClient;

  const FIXTURES = [
    { name: `${stamp}-phone`, transport: "phone", config: { framework: "aeval", phoneDial: { number: "+1 408 837 5890" } } },
    { name: `${stamp}-web`, transport: "web", config: { phoneDial: { number: "+1 555 000 0000" }, stepsPrefix: "- type: platform.setup" } },
    { name: `${stamp}-authored`, transport: "phone", config: { phoneDial: { number: "+1 555 111 2222" }, stepsPrefix: '- type: call.dial\n  number: "+1 555 111 2222"' } },
    { name: `${stamp}-badnum`, transport: "phone", config: { phoneDial: { number: 'x"; not a number' } } },
    { name: `${stamp}-blank`, transport: "phone", config: { phoneDial: { number: "+1 555 333 4444" }, stepsPrefix: "  ", stepsSuffix: "" } },
  ];

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const f of FIXTURES) {
      await client.query(
        `INSERT INTO evalflows (name, owner_id, provider_id, visibility, transport, config)
         VALUES ($1, 1, (SELECT id FROM providers LIMIT 1), 'private', $2, $3::jsonb)`,
        [f.name, f.transport, JSON.stringify(f.config)],
      );
    }
    // Execute the migration file exactly as the runner does (statement split).
    const sql = readFileSync("./migrations/0040_steps_model.sql", "utf-8");
    for (const statement of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await client.query(statement);
    }
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  const configOf = async (name: string): Promise<Record<string, unknown>> => {
    const { rows } = await client.query(`SELECT config FROM evalflows WHERE name = $1`, [name]);
    return rows[0].config;
  };

  it("converts a bare phoneDial phone row to exact-parity steps that pass phone validation", async () => {
    const config = await configOf(`${stamp}-phone`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBe('- type: call.dial\n  number: "+1 408 837 5890"\n- type: call.wait_answered\n');
    expect(config.stepsSuffix).toBe("- type: call.hangup\n");
    expect(validateEvalflowConfig(config, "phone").valid).toBe(true);
  });

  it("a web row only loses the dead key; its authored steps survive; the number is preserved inert", async () => {
    const config = await configOf(`${stamp}-web`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBe("- type: platform.setup");
    expect((config._legacyPhoneDial as any)?.number).toBe("+1 555 000 0000");
  });

  it("a phone row with authored steps keeps them (no silent overwrite)", async () => {
    const config = await configOf(`${stamp}-authored`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBe('- type: call.dial\n  number: "+1 555 111 2222"');
    expect(config.stepsSuffix).toBeUndefined();
  });

  it("a malformed number never reaches the YAML template — but is preserved inert, not destroyed", async () => {
    const config = await configOf(`${stamp}-badnum`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBeUndefined();
    expect((config._legacyPhoneDial as any)?.number).toBe('x"; not a number');
    // The preserved key never blocks a future edit.
    expect(validateEvalflowConfig(config, "phone").valid).toBe(true);
  });

  it("whitespace-only step fields count as absent — the number converts instead of being dropped", async () => {
    const config = await configOf(`${stamp}-blank`);
    expect(config.phoneDial).toBeUndefined();
    expect(String(config.stepsPrefix)).toContain('+1 555 333 4444');
    expect(validateEvalflowConfig(config, "phone").valid).toBe(true);
  });
});

d("migration 0041_remove_vat.sql (transactional, rolled back)", () => {
  const stamp = `mig0041-${Date.now()}`;
  let client: import("pg").PoolClient;
  let vatWfId: number;
  let healthyWfId: number;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const FIXTURES = [
      // Explicit VAT → deleted (unrunnable, uneditable, no steps to fall back on).
      { name: `${stamp}-vat`, config: { framework: "voice-agent-tester", app: 'url: "https://x.example"' } },
      // Ambiguous "implicit VAT": an app payload, no framework, no steps. It
      // PROBABLY relied on an old agent's EVAL_FRAMEWORK default, but could be
      // an aeval row with junk — deletion is irreversible, so it's kept (key
      // dropped, schedules disabled) for a human to decide.
      { name: `${stamp}-implicit`, config: { app: 'url: "https://y.example"' } },
      // Clean aeval row → untouched.
      { name: `${stamp}-aeval`, config: { framework: "aeval", stepsPrefix: "- type: platform.setup" } },
      // Healthy aeval row that merely carries a leftover `app` key (the old
      // validator accepted it anywhere): it ran fine, so it SURVIVES and only
      // loses the dead key.
      { name: `${stamp}-healthy`, config: { framework: "aeval", app: 'url: "https://ok.example"', stepsPrefix: "- type: platform.setup" } },
    ];
    for (const f of FIXTURES) {
      await client.query(
        `INSERT INTO evalflows (name, owner_id, provider_id, visibility, transport, config)
         VALUES ($1, 1, (SELECT id FROM providers LIMIT 1), 'private', 'web', $2::jsonb)`,
        [f.name, JSON.stringify(f.config)],
      );
    }
    const idOf = async (name: string) => (await client.query(`SELECT id FROM evalflows WHERE name = $1`, [name])).rows[0].id;
    vatWfId = await idOf(`${stamp}-vat`);
    healthyWfId = await idOf(`${stamp}-healthy`);
    const aevalWfId = await idOf(`${stamp}-aeval`);

    // Schedules: the VAT row's should orphan on delete (evalflow_id ON DELETE
    // SET NULL — the scheduler disables an orphan on its next tick); the
    // healthy row's must be untouched and still pointed at its evalflow.
    for (const [label, wfId] of [["vat", vatWfId], ["healthy", healthyWfId]] as const) {
      await client.query(
        `INSERT INTO eval_schedules (name, evalflow_id, eval_set_id, region, target_tier, schedule_type, is_enabled, created_by)
         VALUES ($1, $2, NULL, 'na-us-seattle', 'private', 'once', true, 1)`,
        [`${stamp}-${label}-sched`, wfId],
      );
    }

    // A completed job on the VAT row: history survives the evalflow delete
    // (evalflow_id goes NULL; results and authorization by created_by stay).
    await client.query(
      `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
       VALUES ($1, 2, 1, 'na-us-seattle', 'private', $2::jsonb, '{}'::jsonb, 'completed', 0, 0, 3)`,
      [vatWfId, JSON.stringify({ framework: "voice-agent-tester", scenario: "steps: [] # vat-history" })],
    );
    // Queued jobs: explicit VAT and implicit VAT must be FAILED (not deleted —
    // a shared-dispatch row must stay visible to the reap-settle sweep);
    // a healthy queued aeval job must stay pending.
    for (const cfg of [
      { framework: "voice-agent-tester", scenario: "steps: [] # queued-vat" },
      { app: 'url: "https://x.example"', scenario: "steps: [] # queued-implicit" },
      { framework: "aeval", stepsPrefix: "- type: platform.setup", scenario: "steps: [] # queued-healthy" },
    ]) {
      await client.query(
        `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
         VALUES ($1, 2, 1, 'na-us-seattle', 'private', $2::jsonb, '{}'::jsonb, 'pending', 0, 0, 3)`,
        [aevalWfId, JSON.stringify(cfg)],
      );
    }
    // 0040 parked-payload copies frozen into a job (config + snapshot) before
    // mergeEvalConfig learned to strip them.
    for (const [status, marker] of [["pending", "parked-pending"], ["completed", "parked-terminal"]]) {
      await client.query(
        `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
         VALUES ($1, 2, 1, 'na-us-seattle', 'private', $2::jsonb, $3::jsonb, $4, 0, 0, 3)`,
        [
          aevalWfId,
          JSON.stringify({ scenario: `steps: [] # ${marker}`, _legacyPhoneDial: { number: "+1 555 010 1234" } }),
          JSON.stringify({ evalflow: { name: "x", config: { _legacyPhoneDial: { number: "+1 555 010 1234" } } } }),
          status,
        ],
      );
    }

    // A pathological row: config is a JSON scalar, not an object. `scalar -
    // 'key'` raises "cannot delete from scalar" and would abort a migration
    // that runs BEFORE the app starts (the 0037 failure mode).
    await client.query(
      `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
       VALUES ($1, 2, 1, 'na-us-seattle', 'private', 'null'::jsonb,
               $2::jsonb, 'completed', 0, 0, 3)`,
      [aevalWfId, JSON.stringify({ evalflow: { name: "scalar-cfg", config: { _legacyPhoneDial: { number: "+1 555 010 1234" } } } })],
    );

    const sql = readFileSync("./migrations/0041_remove_vat.sql", "utf-8");
    for (const statement of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) {
      await client.query(statement);
    }
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  const exists = async (name: string) =>
    (await client.query(`SELECT 1 FROM evalflows WHERE name = $1`, [name])).rowCount === 1;
  const configOf41 = async (name: string) =>
    (await client.query(`SELECT config FROM evalflows WHERE name = $1`, [name])).rows[0].config as Record<string, unknown>;

  it("DELETES provably-VAT evalflows; keeps the ambiguous shape with its app PARKED as evidence", async () => {
    expect(await exists(`${stamp}-vat`)).toBe(false);
    // Kept — irreversible deletion needs proof, not probability. And the app
    // YAML is parked, not deleted: it's the only record of what the row was
    // configured for, and the triage query keys on it.
    expect(await exists(`${stamp}-implicit`)).toBe(true);
    const implicit = await configOf41(`${stamp}-implicit`);
    expect(implicit.app).toBeUndefined();
    expect(implicit._legacyApp).toBe('url: "https://y.example"');
  });

  it("strips a stray app key from eval sets too (v1 create used to skip validation)", async () => {
    await client.query(
      `INSERT INTO eval_sets (name, owner_id, visibility, config)
       VALUES ($1, 1, 'private', $2::jsonb)`,
      [`${stamp}-es`, JSON.stringify({ scenario: "steps: []", app: 'url: "https://es.example"' })],
    );
    // Re-run the sweep statement the way the runner would.
    await client.query(`UPDATE eval_sets SET config = config - 'app' - 'framework' WHERE config ? 'app' OR config ? 'framework'`);
    const { rows } = await client.query(`SELECT config FROM eval_sets WHERE name = $1`, [`${stamp}-es`]);
    expect(rows[0].config.app).toBeUndefined();
    expect(rows[0].config.scenario).toBe("steps: []");
  });

  it("keeps healthy aeval rows, dropping only the dead app key", async () => {
    expect(await exists(`${stamp}-aeval`)).toBe(true);
    expect(await configOf41(`${stamp}-aeval`)).toEqual({ framework: "aeval", stepsPrefix: "- type: platform.setup" });

    expect(await exists(`${stamp}-healthy`)).toBe(true);
    const healthy = await configOf41(`${stamp}-healthy`);
    expect(healthy.app).toBeUndefined();
    expect(healthy._legacyApp).toBe('url: "https://ok.example"'); // parked, never destroyed
    expect(healthy.framework).toBe("aeval");
    expect(healthy.stepsPrefix).toBe("- type: platform.setup");
  });

  it("DISABLES the schedule before deleting, then orphans it; job history survives", async () => {
    const { rows: sched } = await client.query(
      `SELECT evalflow_id, is_enabled FROM eval_schedules WHERE name = $1`, [`${stamp}-vat-sched`]);
    // Explicitly disabled by the migration — NOT left for the scheduler's
    // orphan path, which only fires once next_run_at arrives.
    expect(sched[0].is_enabled).toBe(false);
    expect(sched[0].evalflow_id).toBeNull(); // ON DELETE SET NULL

    const { rows: healthySched } = await client.query(
      `SELECT evalflow_id, is_enabled FROM eval_schedules WHERE name = $1`, [`${stamp}-healthy-sched`]);
    expect(healthySched[0].evalflow_id).toBe(healthyWfId);
    expect(healthySched[0].is_enabled).toBe(true);

    const { rows: history } = await client.query(
      `SELECT status, evalflow_id FROM eval_jobs WHERE config->>'scenario' LIKE '%# vat-history%'`);
    expect(history[0].status).toBe("completed"); // results survive
    expect(history[0].evalflow_id).toBeNull();
  });

  it("FAILS queued VAT jobs (explicit + implicit) so escrow settles; healthy queued jobs stay pending", async () => {
    const statusOf = async (marker: string) =>
      (await client.query(`SELECT status, error FROM eval_jobs WHERE config->>'scenario' LIKE $1`, [`%# ${marker}%`])).rows[0];
    const vat = await statusOf("queued-vat");
    expect(vat.status).toBe("failed");
    expect(vat.error).toContain("voice-agent-tester was removed");
    expect((await statusOf("queued-implicit")).status).toBe("failed");
    expect((await statusOf("queued-healthy")).status).toBe("pending");
  });

  it("removes 0040 parked-payload copies from every job — config and frozen snapshot", async () => {
    const { rows } = await client.query(
      `SELECT config, snapshot #> '{evalflow,config}' AS wfconfig FROM eval_jobs
       WHERE config->>'scenario' LIKE '%# parked-%'`);
    expect(rows).toHaveLength(2); // pending AND terminal
    for (const row of rows) {
      expect(row.config._legacyPhoneDial).toBeUndefined();
      expect(row.wfconfig._legacyPhoneDial).toBeUndefined();
      expect(String(row.config.scenario)).toContain("steps: []"); // real content intact
    }
  });

  it("survives a job whose config is a JSON scalar (would abort a pre-start migration)", async () => {
    // Reaching this assertion at all proves the migration didn't raise —
    // beforeAll executes the real file. The snapshot side still got cleaned.
    const { rows } = await client.query(
      `SELECT config, snapshot #> '{evalflow,config}' AS wfconfig FROM eval_jobs
       WHERE snapshot #>> '{evalflow,name}' = 'scalar-cfg'`);
    expect(rows[0].config).toBeNull(); // JSON null, left alone
    expect(rows[0].wfconfig._legacyPhoneDial).toBeUndefined();
  });

  it("parked _legacy* payloads never trip the secret scans (collectSecretRefs skips them)", async () => {
    const { collectSecretRefs } = await import("../shared/secrets");
    const refs = collectSecretRefs([
      { _legacyPhoneDial: { number: "${secrets.NOPE}" } },
      { stepsPrefix: "- ${secrets.REAL_ONE}" },
    ]);
    expect(refs.has("NOPE")).toBe(false);
    expect(refs.has("REAL_ONE")).toBe(true);
  });

  it("mergeEvalConfig strips parked payloads from job configs (they never reach agents)", async () => {
    const { mergeEvalConfig } = await import("../server/storage");
    const job = mergeEvalConfig(
      { framework: "aeval", _legacyPhoneDial: { number: "+1 555 010 1234" }, stepsPrefix: "- type: platform.setup" },
      { scenario: "steps: []" },
    );
    expect(job._legacyPhoneDial).toBeUndefined();
    expect(job.stepsPrefix).toBe("- type: platform.setup");
  });
});
