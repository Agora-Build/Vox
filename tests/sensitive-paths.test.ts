import { describe, it, expect } from "vitest";
import { isSensitiveResponsePath } from "../server/sensitive-paths";

describe("response-body redaction list", () => {
  // This list has already failed once in exactly this way: /api/secrets was
  // present and /api/org-secrets was not, so adding credential fingerprints to
  // both routes gated one at the route level and wrote the other straight into
  // the container log. Prefix matching does NOT relate the two paths.
  it("covers BOTH secrets routes, which are not prefixes of one another", () => {
    expect(isSensitiveResponsePath("/api/secrets")).toBe(true);
    expect(isSensitiveResponsePath("/api/org-secrets")).toBe(true);
    expect("/api/org-secrets".startsWith("/api/secrets")).toBe(false); // why it needs its own entry
  });

  it("covers the per-name and per-job sub-routes by prefix", () => {
    expect(isSensitiveResponsePath("/api/secrets/AGORA_CONSOLE_PASSWORD")).toBe(true);
    expect(isSensitiveResponsePath("/api/org-secrets/SHARED_LOGIN")).toBe(true);
    expect(isSensitiveResponsePath("/api/eval-agent/jobs/123/secrets")).toBe(true);
  });

  it("does not redact ordinary routes", () => {
    for (const p of ["/api/workflows", "/api/metrics/realtime", "/api/eval-agents", "/api/config"]) {
      expect(isSensitiveResponsePath(p)).toBe(false);
    }
  });
});
