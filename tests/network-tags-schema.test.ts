import { describe, it, expect } from "vitest";
import { pool } from "../server/storage";
import { buildJobSnapshot } from "../server/storage";
import type { EvalFlow, Provider } from "../shared/schema";

// Network tags (designs/2026-10-22-network-tags-design.md "Data model"):
// eval_flows.tags/line_lookup, eval_agents.tags/link_type, eval_jobs.tags,
// and the number_lookups cache table — added by migration 0057. This test
// checks the migration actually applied the right shape (columns, defaults,
// nullability) and that buildJobSnapshot() freezes a flow's tags + line
// lookup into the job snapshot, so editing the flow later never rewrites it.

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("network tags: migration 0057", () => {
  it("eval_flows gains tags (jsonb, not null, default []) and line_lookup (jsonb, nullable)", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'eval_flows' AND column_name IN ('tags', 'line_lookup')`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.tags?.data_type).toBe("jsonb");
    expect(byName.tags?.is_nullable).toBe("NO");
    expect(byName.tags?.column_default).toContain("[]");
    expect(byName.line_lookup?.data_type).toBe("jsonb");
    expect(byName.line_lookup?.is_nullable).toBe("YES");
  });

  it("eval_agents gains tags (jsonb, not null, default []) and link_type (varchar(16), nullable)", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'eval_agents' AND column_name IN ('tags', 'link_type')`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.tags?.data_type).toBe("jsonb");
    expect(byName.tags?.is_nullable).toBe("NO");
    expect(byName.tags?.column_default).toContain("[]");
    expect(byName.link_type?.data_type).toBe("character varying");
    expect(byName.link_type?.character_maximum_length).toBe(16);
    expect(byName.link_type?.is_nullable).toBe("YES");
  });

  it("eval_jobs gains tags (jsonb, nullable — null for pre-release jobs)", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'eval_jobs' AND column_name = 'tags'`
    );
    expect(rows[0]?.data_type).toBe("jsonb");
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("number_lookups exists with the per-number cache shape", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
       FROM information_schema.columns
       WHERE table_name = 'number_lookups'`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.number?.data_type).toBe("character varying");
    expect(byName.number?.character_maximum_length).toBe(20);
    expect(byName.provider?.data_type).toBe("character varying");
    expect(byName.provider?.character_maximum_length).toBe(16);
    expect(byName.provider?.is_nullable).toBe("NO");
    expect(byName.carrier_name?.data_type).toBe("text");
    expect(byName.line_type?.data_type).toBe("character varying");
    expect(byName.line_type?.character_maximum_length).toBe(32);
    expect(byName.value?.data_type).toBe("character varying");
    expect(byName.value?.character_maximum_length).toBe(48);
    expect(byName.looked_up_at?.data_type).toContain("timestamp");
    expect(byName.looked_up_at?.is_nullable).toBe("NO");

    const pk = await pool.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'number_lookups'::regclass AND i.indisprimary`
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["number"]);
  });
});

describe("buildJobSnapshot: flow tags + line lookup", () => {
  it("carries the flow's hand-set tags and line_lookup into the snapshot", () => {
    const evalFlow = {
      id: 1,
      name: "Test Flow",
      description: null,
      ownerId: 7,
      projectId: null,
      providerId: "prov1",
      organizationId: null,
      visibility: "public",
      isMainline: false,
      transport: "phone",
      config: {},
      tags: [{ key: "line", value: "twilio" }],
      lineLookup: {
        value: "twilio",
        carrierName: "Twilio - SMS/MMS-SVR",
        lineType: "nonFixedVoip",
        lookedUpAt: "2026-10-22T00:00:00.000Z",
        number: "…1234",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EvalFlow;
    const provider = { id: "prov1", name: "Agora", platformId: "agora" } as unknown as Provider;

    const snapshot = buildJobSnapshot(evalFlow, null, provider, "premium");

    expect(snapshot.evalFlow?.tags).toEqual([{ key: "line", value: "twilio" }]);
    expect(snapshot.evalFlow?.lineLookup).toEqual({
      value: "twilio",
      carrierName: "Twilio - SMS/MMS-SVR",
      lineType: "nonFixedVoip",
      lookedUpAt: "2026-10-22T00:00:00.000Z",
      number: "…1234",
    });
  });

  it("defaults to an empty tags array and null lineLookup when the flow has none (keeps old snapshots valid)", () => {
    const evalFlow = {
      id: 2,
      name: "No Tags Flow",
      description: null,
      ownerId: 7,
      projectId: null,
      providerId: "prov1",
      organizationId: null,
      visibility: "public",
      isMainline: false,
      transport: "web",
      config: {},
      tags: [],
      lineLookup: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EvalFlow;

    const snapshot = buildJobSnapshot(evalFlow, null, null, null);

    expect(snapshot.evalFlow?.tags).toEqual([]);
    expect(snapshot.evalFlow?.lineLookup).toBeNull();
  });
});
