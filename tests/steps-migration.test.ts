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

  it("a web row only loses the dead key; its authored steps survive", async () => {
    const config = await configOf(`${stamp}-web`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBe("- type: platform.setup");
  });

  it("a phone row with authored steps keeps them (no silent overwrite)", async () => {
    const config = await configOf(`${stamp}-authored`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBe('- type: call.dial\n  number: "+1 555 111 2222"');
    expect(config.stepsSuffix).toBeUndefined();
  });

  it("a malformed number never reaches the YAML template", async () => {
    const config = await configOf(`${stamp}-badnum`);
    expect(config.phoneDial).toBeUndefined();
    expect(config.stepsPrefix).toBeUndefined();
  });

  it("whitespace-only step fields count as absent — the number converts instead of being dropped", async () => {
    const config = await configOf(`${stamp}-blank`);
    expect(config.phoneDial).toBeUndefined();
    expect(String(config.stepsPrefix)).toContain('+1 555 333 4444');
    expect(validateEvalflowConfig(config, "phone").valid).toBe(true);
  });
});
