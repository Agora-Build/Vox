import { describe, it, expect } from "vitest";
import { BASE_NA } from "./helpers/regions";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie");
  return setCookie.split(";")[0];
}

async function authStatus(cookie: string): Promise<{ user: { organizationId: number | null } | null }> {
  const res = await fetch(`${BASE_URL}/api/auth/status`, { headers: { Cookie: cookie } });
  return res.json();
}

function createToken(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/eval-agent-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

d("POST /api/eval-agent-tokens dispatchTier rules", () => {
  it("admin default tier is public", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await createToken(cookie, { name: `t-admin-${Date.now()}`, regionLocationBaseId: BASE_NA });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.dispatchTier).toBe("public");
    expect(body.token).toBeDefined();
  });

  it("admin may create private", async () => {
    // Zero trust: region is public-tier-only, even for admin — a private
    // token mints region-less regardless of who creates it.
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await createToken(cookie, { name: `t-admin-priv-${Date.now()}`, dispatchTier: "private" });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.dispatchTier).toBe("private");
    expect(body.siteId).toBeNull();
  });

  it("admin team tier depends on org membership", async () => {
    // Seed admin's org membership is environment-dependent — branch on it
    // rather than assuming. With an org: team succeeds (200). Without: team
    // requires org membership and is rejected (400). Team is non-public, so
    // (per the zero-trust region contract) it never takes a region either.
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const status = await authStatus(cookie);
    const res = await createToken(cookie, { name: `t-team-${Date.now()}`, dispatchTier: "team" });
    if (status.user?.organizationId) {
      expect(res.ok).toBe(true);
      expect((await res.json()).dispatchTier).toBe("team");
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("shared without price is rejected (400) or unavailable when no marketplace", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await createToken(cookie, { name: `t-shared-noprice-${Date.now()}`, dispatchTier: "shared" });
    expect(res.status).toBe(400);
  });
});
