import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// The /api/admin prefix is exact for Core routes (server/routes.ts): every
// admin-only route lives under it, and everything under it is admin-only.
// Plugins keep their own admin routes under /api/plugins/<id>. That makes the prefix safe to govern as
// a unit (rate limits, audit, log rules) and obvious in review and in logs.
// A route guarded by requireAdmin elsewhere (as provider writes used to be,
// at /api/providers) fails here, and so does an /api/admin route without it.

const raw = readFileSync("server/routes.ts", "utf8");
// Comments blanked out (same length, so line numbers stay right): a
// "requireAdmin" in a comment must not count as the guard.
const src = raw.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
const routes = Array.from(
  src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,([^]*?)(?:async\s*\(|\(\s*req)/g),
  (m) => ({
    method: m[1].toUpperCase(),
    path: m[2],
    // The middleware names, in order, e.g. ["requireAuth", "requireAdmin"].
    chain: m[3].split(",").map((x) => x.trim()).filter(Boolean),
    line: src.slice(0, m.index).split("\n").length,
  }),
);
const hasAdmin = (r: { chain: string[] }) => r.chain.includes("requireAdmin");

describe("the /api/admin prefix is exact", () => {
  it("finds the routes it checks (guards against a parser that silently matches nothing)", () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.filter((r) => r.path.startsWith("/api/admin")).length).toBeGreaterThan(25);
  });

  it("the scan reads every route declaration — none in a form it can't parse", () => {
    // A path in a variable, or a named handler instead of an inline one, would
    // not match the scan; counting every declaration makes that fail here
    // instead of the route silently escaping the checks below.
    const declared = (src.match(/app\.(get|post|put|patch|delete)\(/g) ?? []).length;
    expect(routes.length).toBe(declared);
  });

  it("every route path is a plain double-quoted string the scan can read", () => {
    // A path in single quotes or a template literal would be skipped silently.
    const unreadable = Array.from(src.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`']/g),
      (m) => `routes.ts:${src.slice(0, m.index).split("\n").length}`);
    expect(unreadable).toEqual([]);
  });

  it("every route guarded by requireAdmin is under /api/admin", () => {
    const outside = routes
      .filter((r) => hasAdmin(r) && !r.path.startsWith("/api/admin"))
      .map((r) => `${r.method} ${r.path} (routes.ts:${r.line})`);
    expect(outside).toEqual([]);
  });

  it("every route under /api/admin is exactly requireAuth, requireAdmin — session only", () => {
    // requireAdmin alone would accept an API-key user; requireAuthOrApiKey
    // likewise. Admin routes take a browser session, and nothing else.
    const wrong = routes
      .filter((r) => r.path.startsWith("/api/admin") && r.chain.join(",") !== "requireAuth,requireAdmin")
      .map((r) => `${r.method} ${r.path} [${r.chain.join(", ")}] (routes.ts:${r.line})`);
    expect(wrong).toEqual([]);
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
