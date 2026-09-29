import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// The /api/admin prefix is exact: every admin-only route lives under it, and
// everything under it is admin-only. That makes the prefix safe to govern as
// a unit (rate limits, audit, log rules) and obvious in review and in logs.
// A route guarded by requireAdmin elsewhere (as provider writes used to be,
// at /api/providers) fails here, and so does an /api/admin route without it.

const src = readFileSync("server/routes.ts", "utf8");
const routes = Array.from(
  src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,([^]*?)(?:async\s*\(|\(\s*req)/g),
  (m) => ({ method: m[1].toUpperCase(), path: m[2], middleware: m[3], line: src.slice(0, m.index).split("\n").length }),
);

describe("the /api/admin prefix is exact", () => {
  it("finds the routes it checks (guards against a parser that silently matches nothing)", () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.filter((r) => r.path.startsWith("/api/admin")).length).toBeGreaterThan(25);
  });

  it("every route guarded by requireAdmin is under /api/admin", () => {
    const outside = routes
      .filter((r) => /\brequireAdmin\b/.test(r.middleware) && !r.path.startsWith("/api/admin"))
      .map((r) => `${r.method} ${r.path} (routes.ts:${r.line})`);
    expect(outside).toEqual([]);
  });

  it("every route under /api/admin is guarded by requireAdmin", () => {
    const unguarded = routes
      .filter((r) => r.path.startsWith("/api/admin") && !/\brequireAdmin\b/.test(r.middleware))
      .map((r) => `${r.method} ${r.path} (routes.ts:${r.line})`);
    expect(unguarded).toEqual([]);
  });

  it("the clash-runner list, open to principal/fellow too, is not under /api/admin", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("GET /api/clash/runners");
    expect(paths).not.toContain("GET /api/admin/clash-runners");
  });

  it("provider writes are admin routes; the provider list stays public", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /api/admin/providers");
    expect(paths).toContain("PATCH /api/admin/providers/:id");
    expect(paths).toContain("GET /api/providers");
    expect(paths).not.toContain("POST /api/providers");
    expect(paths).not.toContain("PATCH /api/providers/:id");
  });
});
