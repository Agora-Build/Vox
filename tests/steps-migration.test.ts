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

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const FIXTURES = [
      { name: `${stamp}-vat`, config: { framework: "voice-agent-tester", app: 'url: "https://x.example"' } },
      { name: `${stamp}-app-only`, config: { framework: "aeval", app: 'url: "https://y.example"' } },
      { name: `${stamp}-aeval`, config: { framework: "aeval", stepsPrefix: "- type: platform.setup" } },
      // Healthy aeval row that merely carries a leftover `app` key (the old
      // validator accepted it on any evalflow) — it ran fine and must KEEP
      // its schedule; only the dead key is parked.
      { name: `${stamp}-healthy`, config: { framework: "aeval", app: 'url: "https://ok.example"', stepsPrefix: "- type: platform.setup" } },
    ];
    for (const f of FIXTURES) {
      await client.query(
        `INSERT INTO evalflows (name, owner_id, provider_id, visibility, transport, config)
         VALUES ($1, 1, (SELECT id FROM providers LIMIT 1), 'private', 'web', $2::jsonb)`,
        [f.name, JSON.stringify(f.config)],
      );
    }
    // A schedule on the to-be-converted row: the migration must disable it
    // (an ex-VAT evalflow has no Setup Steps — scheduled runs would proceed
    // quietly against a target nobody configured).
    for (const wfName of [`${stamp}-vat`, `${stamp}-healthy`]) {
      const { rows: [wfRow] } = await client.query(`SELECT id FROM evalflows WHERE name = $1`, [wfName]);
      await client.query(
        `INSERT INTO eval_schedules (name, evalflow_id, eval_set_id, region, target_tier, schedule_type, is_enabled, created_by)
         VALUES ($1, $2, NULL, 'na-us-seattle', 'private', 'once', true, 1)`,
        [`${wfName}-sched`, wfRow.id],
      );
    }
    // A pending job whose frozen config still carries a parked payload (it
    // was merged before mergeEvalConfig learned to strip) plus a terminal one
    // that must stay untouched (history).
    const { rows: [jobWf] } = await client.query(`SELECT id FROM evalflows WHERE name = $1`, [`${stamp}-aeval`]);
    for (const [status, marker] of [["pending", "pending"], ["completed", "terminal"]]) {
      await client.query(
        `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
         VALUES ($1, 2, 1, 'na-us-seattle', 'private', $2::jsonb, $3::jsonb, $4, 0, 0, 3)`,
        [
          jobWf.id,
          JSON.stringify({ scenario: `steps: [] # ${marker}`, _legacyPhoneDial: { number: "+1 555 010 1234" } }),
          JSON.stringify({ evalflow: { name: "x", config: { _legacyPhoneDial: { number: "+1 555 010 1234" } } } }),
          status,
        ],
      );
    }
    // A queued job frozen on the removed framework: must be failed by the
    // migration, not left for an agent to claim and fail (escrow round-trip).
    await client.query(
      `INSERT INTO eval_jobs (evalflow_id, trigger_type, created_by, target_region, target_tier, config, snapshot, status, priority, retry_count, max_retries)
       VALUES ($1, 2, 1, 'na-us-seattle', 'private', $2::jsonb, '{}'::jsonb, 'pending', 0, 0, 3)`,
      [jobWf.id, JSON.stringify({ framework: "voice-agent-tester", scenario: "steps: [] # queued-vat" })],
    );
    const sql = readFileSync("./migrations/0041_remove_vat.sql", "utf-8");
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

  it("parked _legacy* payloads never trip the secret scans (collectSecretRefs skips them)", async () => {
    const { collectSecretRefs } = await import("../shared/secrets");
    const refs = collectSecretRefs([
      { framework: "aeval", _legacyVatApp: "header: Bearer ${secrets.LOGIN_PASSWORD}" },
      { _legacyPhoneDial: { number: "${secrets.NOPE}" } },
      { stepsPrefix: "- ${secrets.REAL_ONE}" },
    ]);
    expect(refs.has("LOGIN_PASSWORD")).toBe(false);
    expect(refs.has("NOPE")).toBe(false);
    expect(refs.has("REAL_ONE")).toBe(true);
  });

  it("a VAT row becomes aeval with its app payload parked inert, and passes validation", async () => {
    const config = await configOf(`${stamp}-vat`);
    expect(config.framework).toBe("aeval");
    expect(config.app).toBeUndefined();
    expect(config._legacyVatApp).toBe('url: "https://x.example"');
    expect(validateEvalflowConfig(config, "web").valid).toBe(true);
  });

  it("a stray app key on an aeval row is parked too", async () => {
    const config = await configOf(`${stamp}-app-only`);
    expect(config.app).toBeUndefined();
    expect(config._legacyVatApp).toBe('url: "https://y.example"');
    expect(validateEvalflowConfig(config, "web").valid).toBe(true);
  });

  it("disables schedules ONLY where the row can't run as aeval (no steps); healthy rows keep theirs", async () => {
    const enabledOf = async (name: string) => {
      const { rows } = await client.query(`SELECT is_enabled FROM eval_schedules WHERE name = $1`, [name]);
      return rows[0].is_enabled;
    };
    // Ex-VAT, no Setup Steps → disabled.
    expect(await enabledOf(`${stamp}-vat-sched`)).toBe(false);
    // aeval with working steps and only a stray `app` key → still enabled.
    expect(await enabledOf(`${stamp}-healthy-sched`)).toBe(true);
  });

  it("a healthy aeval row loses only the dead key (steps + framework intact)", async () => {
    const config = await configOf(`${stamp}-healthy`);
    expect(config.app).toBeUndefined();
    expect(config._legacyVatApp).toBe('url: "https://ok.example"');
    expect(config.framework).toBe("aeval");
    expect(config.stepsPrefix).toBe("- type: platform.setup");
  });

  it("mergeEvalConfig strips parked payloads from job configs (they never reach agents)", async () => {
    const { mergeEvalConfig } = await import("../server/storage");
    const job = mergeEvalConfig(
      { framework: "aeval", _legacyPhoneDial: { number: "+1 555 010 1234" }, stepsPrefix: "- type: platform.setup" },
      { scenario: "steps: []", _legacyVatApp: "x" },
    );
    expect(job._legacyPhoneDial).toBeUndefined();
    expect(job._legacyVatApp).toBeUndefined();
    expect(job.stepsPrefix).toBe("- type: platform.setup");
  });

  it("strips parked payloads from EVERY job — config and frozen snapshot, terminal rows included", async () => {
    // These keys are dead data parked by 0040 itself, never provenance
    // content: a terminal job is readable by whoever RAN the evalflow (anyone
    // may run a public one), so leaving the owner's number there is a leak
    // the read boundary shouldn't have to carry alone.
    const { rows } = await client.query(
      `SELECT status, config, snapshot #> '{evalflow,config}' AS wfconfig FROM eval_jobs
       WHERE config->>'scenario' LIKE '%# pending%' OR config->>'scenario' LIKE '%# terminal%'`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.config._legacyPhoneDial).toBeUndefined();
      expect(row.wfconfig._legacyPhoneDial).toBeUndefined();
      // Real content survives — only the parked key goes.
      expect(String(row.config.scenario)).toContain("steps: []");
    }
  });

  it("fails queued jobs frozen on the removed framework (no wasted claim + escrow round-trip)", async () => {
    const { rows } = await client.query(
      `SELECT status, error FROM eval_jobs WHERE config->>'scenario' LIKE '%# queued-vat%'`,
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("voice-agent-tester was removed");
  });

  it("a clean aeval row is untouched", async () => {
    const config = await configOf(`${stamp}-aeval`);
    expect(config).toEqual({ framework: "aeval", stepsPrefix: "- type: platform.setup" });
  });
});
