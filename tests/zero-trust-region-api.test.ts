import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

describe("zero-trust token mint", () => {
  let cookie: string;
  const created: number[] = [];

  beforeAll(async () => { cookie = await login(); });
  afterAll(async () => {
    for (const id of created) {
      await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${id}/revoke`, { method: "POST" });
    }
  });

  const mint = (body: Record<string, unknown>) =>
    authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, { method: "POST", body: JSON.stringify(body) });

  it("public tier still requires and honors a region (admin path unchanged)", async () => {
    const res = await mint({ name: `zt-pub-${Date.now()}`, regionLocationBaseId: "na-us-seattle", dispatchTier: "public" });
    expect(res.status).toBe(200);
    const token = await res.json();
    created.push(token.id);
    // Sequence width isn't fixed at 2 digits — the dev DB's region counter
    // accumulates across test runs (see CLAUDE.md "Known gate hazard"), so
    // assert only on the prefix + numeric suffix, not a specific digit count.
    expect(token.siteId).toMatch(/^na-us-seattle-\d+$/);
  });

  it("public tier without a region → 400", async () => {
    const res = await mint({ name: `zt-pub-nr-${Date.now()}`, dispatchTier: "public" });
    expect(res.status).toBe(400);
  });

  it("non-public mint REJECTS a caller-supplied region (zero trust, never silently ignored)", async () => {
    const res = await mint({ name: `zt-priv-${Date.now()}`, regionLocationBaseId: "na-us-seattle", dispatchTier: "private" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/detected automatically/i);
  });

  it("non-public mint without a region succeeds with siteId null", async () => {
    const res = await mint({ name: `zt-priv-ok-${Date.now()}`, dispatchTier: "private" });
    expect(res.status).toBe(200);
    const token = await res.json();
    created.push(token.id);
    expect(token.siteId).toBeNull();
    expect(token.token).toMatch(/^[A-Za-z0-9_-]/); // secret still returned once
  });

  it("token list returns null siteId for non-public tokens", async () => {
    const list = await (await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`)).json();
    const mine = list.find((t: { id: number }) => t.id === created[created.length - 1]);
    expect(mine.siteId).toBeNull();
  });
});
