import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { isSensitiveResponsePath } from "../server/sensitive-paths";

/**
 * Every route whose handler returns a plaintext credential, discovered by
 * scanning the source rather than listed by hand.
 *
 * The hand-written version of this test asserted five known-good paths and so
 * could not detect a credential route nobody had added to either file — which
 * is exactly how `/api/eval-agent-tokens` and `/api/admin/users/:id/activation-link`
 * stayed missing while the suite was green. A list is only as good as the thing
 * that checks it.
 */
function credentialReturningRoutes(): { route: string; line: number; text: string }[] {
  const lines = readFileSync("server/routes.ts", "utf8").split("\n");
  const CREDENTIAL = /\b(token|mintSecret|activationUrl|apiKey|secretKey)\b\s*[,:}]/;
  // tokenHash is a digest; tokenId/hasToken are references, not the value.
  // `token: {` is an object literal/type-annotation shape (e.g. call-argument
  // `token: { id: ..., dispatchTier: ... }` or a type annotation like
  // `token: { siteId: ...; region: ...; dispatchTier: ... }`), never a
  // plaintext credential value.
  const NOT_A_VALUE = /tokenHash|hasToken|tokenId|token:\s*null|token:\s*\{/;

  const found: { route: string; line: number; text: string }[] = [];
  let route: string | null = null;
  lines.forEach((raw, i) => {
    const decl = /app\.(get|post|patch|put|delete)\("([^"]+)"/.exec(raw);
    if (decl) route = decl[2];
    if (!route) return;
    const isResponseShape = raw.includes("res.json(") || /^\s*(token|mintSecret|activationUrl|apiKey)\s*[,:]/.test(raw);
    if (!isResponseShape || !CREDENTIAL.test(raw) || NOT_A_VALUE.test(raw)) return;
    found.push({ route, line: i + 1, text: raw.trim().slice(0, 80) });
  });
  return found;
}

/** `/api/admin/users/:id/activation-link` -> a path the matcher would really see. */
const concrete = (route: string) => route.replace(/:[A-Za-z0-9_]+/g, "42");

describe("response-body redaction list", () => {
  it("covers EVERY route in server/routes.ts that returns a credential", () => {
    const routes = credentialReturningRoutes();
    // Guard the guard: if the scan silently stops matching, this test would
    // pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(8);

    const uncovered = [...new Set(routes.map((r) => r.route))]
      .filter((r) => !isSensitiveResponsePath(concrete(r)));
    expect(uncovered, `credential-returning routes missing from SENSITIVE_PATHS: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("covers both secrets routes, which are not prefixes of one another", () => {
    expect(isSensitiveResponsePath("/api/secrets")).toBe(true);
    expect(isSensitiveResponsePath("/api/org-secrets")).toBe(true);
    expect("/api/org-secrets".startsWith("/api/secrets")).toBe(false); // why it needs its own entry
  });

  it("covers per-name and per-job sub-routes by prefix", () => {
    expect(isSensitiveResponsePath("/api/secrets/AGORA_CONSOLE_PASSWORD")).toBe(true);
    expect(isSensitiveResponsePath("/api/eval-agent/jobs/123/secrets")).toBe(true);
  });

  it("does not redact ordinary routes", () => {
    for (const p of ["/api/workflows", "/api/metrics/realtime", "/api/eval-agents", "/api/config"]) {
      expect(isSensitiveResponsePath(p)).toBe(false);
    }
  });
});
