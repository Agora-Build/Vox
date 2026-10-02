import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { db, storage } from "../server/storage";

const FROM = Date.UTC(2026, 0, 1);
const DAY = 86400000;

/** Capture real tier predicates while replacing only query execution. */
function captureQueries(results: unknown[][]) {
  const predicates: Array<{ sql: string; params: unknown[] }> = [];
  const limits: number[] = [];
  const dialect = new PgDialect();
  vi.spyOn(db, "select").mockImplementation((() => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "orderBy", "groupBy"]) query[method] = () => query;
    query.where = (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      predicates.push(dialect.sqlToQuery(predicate));
      return query;
    };
    query.limit = (limit: number) => {
      limits.push(limit);
      return Promise.resolve(results.shift() ?? []);
    };
    return query;
  }) as typeof db.select);
  return { predicates, limits };
}

afterEach(() => vi.restoreAllMocks());

describe("metrics detail storage", () => {
  it("queries historical bounds with the mainline snapshot, trust, region, and transport gates", async () => {
    const { predicates, limits } = captureQueries([]);
    await storage.getMetricsDetail("mainline", { from: FROM, to: FROM + DAY }, undefined, { baseIds: ["eu-de-frankfurt"] }, "phone");
    const { sql, params } = predicates[0];
    expect(sql).toContain('"eval_results"."created_at" >=');
    expect(sql).toContain('"eval_results"."created_at" <');
    expect(sql).toContain('"eval_jobs"."transport"');
    expect(sql).toContain('"eval_jobs"."snapshot"');
    expect(sql).toContain('"eval_jobs"."token_dispatch_tier"');
    expect(params).toContain("phone");
    expect(params).toContain(new Date(FROM).toISOString());
    expect(params).toContain(new Date(FROM + DAY).toISOString());
    expect(params.some(value => String(value).includes("eu-de-frankfurt"))).toBe(true);
    expect(limits).toEqual([20001]);
  });

  it("applies Community location trust gates to fine-detail queries", async () => {
    const { predicates } = captureQueries([]);
    await storage.getMetricsDetail("community", { from: FROM, to: FROM + DAY });
    expect(predicates[0].sql).toContain('"eval_jobs"."location_trust"');
    expect(predicates[0].params).toContain("trusted");
  });

  it("keeps My Evals user-scoped and rejects unauthenticated storage calls", async () => {
    const { predicates } = captureQueries([]);
    await expect(storage.getMetricsDetail("myEvals", { from: FROM, to: FROM + DAY })).rejects.toThrow("requires a user");
    expect(predicates).toHaveLength(0);
    await storage.getMetricsDetail("myEvals", { from: FROM, to: FROM + DAY }, 123, { unverified: true });
    expect(predicates[0].params).toContain(123);
    expect(predicates[0].sql).toContain('"eval_jobs"."created_by"');
    expect(predicates[0].sql).toContain('is null');
  });

  it("preserves raw test identity from immutable job snapshots", async () => {
    captureQueries([[{ eval_results: { id: 9 }, eval_jobs: { evalFlowId: 7, snapshot: { evalFlow: { name: "Historic flow" } } } }]]);
    const result = await storage.getMetricsDetail("community", { from: FROM, to: FROM + DAY });
    expect(result).toMatchObject({ from: FROM, to: FROM + DAY, resolution: "raw", truncated: false });
    expect(result.metrics).toEqual([{ id: 9, evalFlowId: 7, evalFlowName: "Historic flow", transport: "web" }]);
  });

  it("falls back to complete hourly buckets when raw detail exceeds the ceiling", async () => {
    const { limits } = captureQueries([Array(20001).fill({}), [{ id: 1 }]]);
    const result = await storage.getMetricsDetail("community", { from: FROM + 60000, to: FROM + 120000 });
    expect(result).toMatchObject({ from: FROM, to: FROM + 3600000, resolution: "hour", truncated: false });
    expect(result.metrics).toEqual([{ id: 1, transport: "web" }]);
    expect(limits).toEqual([20001, 20001]);
  });

  it("falls back to daily buckets for an oversized hourly payload and reports any final truncation", async () => {
    captureQueries([Array(20001).fill({}), Array(20001).fill({ id: 1 })]);
    const result = await storage.getMetricsDetail("community", { from: FROM, to: FROM + 30 * DAY });
    expect(result.resolution).toBe("day");
    expect(result.truncated).toBe(true);
    expect(result.metrics).toHaveLength(20000);
  });
});
