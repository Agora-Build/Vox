import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, pool } from "../server/storage";

// Network tags — number lookup through the API (designs/2026-10-22-network-tags-design.md
// "Number lookup (line)"), against the running dev server. The lookup itself
// is covered with a stub Twilio in tests/number-lookup.test.ts; this suite
// never lets the dev server reach Twilio: credentials are absent whenever a
// phone flow is saved here (any pre-existing dev credentials are stashed as
// the raw encrypted row and restored afterwards).

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";
const CONFIG_KEY = "twilio_lookup_credentials";
const SID = "AC" + "fedcba9876543210fedcba9876543210";
const TOKEN = "integration-test-auth-token";

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function jsonFetch(url: string, opts: RequestInit & { cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, ok: res.ok, body, text };
}

d("number lookup API", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let adminCookie = "";
  let providerId = "";
  const users: Array<{ email: string; cookie: string; id: number }> = [];
  const flowIds: number[] = [];
  let stashed: string | null = null;

  async function makeUser(tag: string) {
    const email = `nlapi${tag}-${stamp}@example.com`;
    const invite = await jsonFetch(`${BASE_URL}/api/admin/invite`, {
      method: "POST", cookie: adminCookie, body: JSON.stringify({ email, plan: "premium" }),
    });
    expect(invite.ok).toBe(true);
    await jsonFetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      body: JSON.stringify({ username: `nlapi${tag}${stamp}`, password: "TestPass123!", token: invite.body.token }),
    });
    const row = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    const u = { email, id: row.rows[0].id, cookie: await login(email, "TestPass123!") };
    users.push(u);
    return u;
  }

  beforeAll(async () => {
    const existing = await pool.query("SELECT value FROM system_config WHERE key = $1", [CONFIG_KEY]);
    stashed = existing.rows[0]?.value ?? null;
    await pool.query("DELETE FROM system_config WHERE key = $1", [CONFIG_KEY]);
    adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    providerId = (await storage.getAllProviders())[0].id;
    await makeUser("a");
    await makeUser("b");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM system_config WHERE key = $1", [CONFIG_KEY]).catch(() => {});
    if (stashed !== null) {
      await pool.query("INSERT INTO system_config (key, value) VALUES ($1, $2)", [CONFIG_KEY, stashed]).catch(() => {});
    }
    if (flowIds.length) await pool.query("DELETE FROM eval_flows WHERE id = ANY($1)", [flowIds]).catch(() => {});
    const ids = users.map((u) => u.id);
    if (ids.length) await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids]).catch(() => {});
  });

  it("admin credential routes are admin-only (401 unauthenticated, 403 non-admin)", async () => {
    const url = `${BASE_URL}/api/admin/number-lookup/twilio`;
    for (const method of ["GET", "PUT", "DELETE"]) {
      const body = method === "PUT" ? JSON.stringify({ accountSid: SID, authToken: TOKEN }) : undefined;
      expect((await jsonFetch(url, { method, body })).status).toBe(401);
      expect((await jsonFetch(url, { method, body, cookie: users[0].cookie })).status).toBe(403);
    }
    const row = await pool.query("SELECT 1 FROM system_config WHERE key = $1", [CONFIG_KEY]);
    expect(row.rowCount).toBe(0);
  });

  it("PUT validates, stores encrypted, GET shows only configured + masked SID, DELETE clears", async () => {
    const url = `${BASE_URL}/api/admin/number-lookup/twilio`;
    expect((await jsonFetch(url, { cookie: adminCookie })).body).toEqual({ configured: false, accountSidMasked: null });

    for (const bad of [{ accountSid: "AC123", authToken: TOKEN }, { accountSid: SID, authToken: "" }, { authToken: TOKEN }]) {
      const r = await jsonFetch(url, { method: "PUT", cookie: adminCookie, body: JSON.stringify(bad) });
      expect(r.status).toBe(400);
    }

    const put = await jsonFetch(url, { method: "PUT", cookie: adminCookie, body: JSON.stringify({ accountSid: SID, authToken: TOKEN }) });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(TOKEN);
    try {
      const raw = await pool.query("SELECT value FROM system_config WHERE key = $1", [CONFIG_KEY]);
      expect(raw.rows[0].value).not.toContain(TOKEN);

      const get = await jsonFetch(url, { cookie: adminCookie });
      expect(get.body).toEqual({ configured: true, accountSidMasked: "AC…3210" });
      expect(get.text).not.toContain(TOKEN);
      expect(get.text).not.toContain(SID);
    } finally {
      const del = await jsonFetch(url, { method: "DELETE", cookie: adminCookie });
      expect(del.status).toBe(200);
    }
    expect((await jsonFetch(url, { cookie: adminCookie })).body).toEqual({ configured: false, accountSidMasked: null });
  });

  it("a phone flow saves with no credentials configured; lineLookup stays null", async () => {
    const created = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: users[0].cookie,
      body: JSON.stringify({
        name: `nlapi-phone-${stamp}`, providerId, visibility: "public", transport: "phone",
        config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-1234"\n', stepsSuffix: "- type: call.hangup\n" },
      }),
    });
    expect(created.status).toBe(200);
    flowIds.push(created.body.id);
    // The save never waits for the lookup: it answers with the current
    // lineLookup (none yet) and says a lookup was started.
    expect(created.body.lineLookup).toBeNull();
    expect(created.body.lineLookupPending).toBe(true);

    const patched = await jsonFetch(`${BASE_URL}/api/eval-flows/${created.body.id}`, {
      method: "PATCH", cookie: users[0].cookie,
      body: JSON.stringify({ config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-9876"\n', stepsSuffix: "- type: call.hangup\n" } }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.lineLookup).toBeNull();
    expect(patched.body.lineLookupPending).toBe(true);
    // A save that changes nothing about the number starts no lookup… except
    // that "no lookup yet" always retries; a web flow never does.
    const web = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: users[0].cookie,
      body: JSON.stringify({ name: `nlapi-web-${stamp}`, providerId, visibility: "public", transport: "web", config: {} }),
    });
    expect(web.status).toBe(200);
    flowIds.push(web.body.id);
    expect(web.body).not.toHaveProperty("lineLookupPending");
  });

  it("v1 PUT that changes the dialled number refreshes the lookup — a stale answer is cleared (finding 3)", async () => {
    const created = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: users[0].cookie,
      body: JSON.stringify({
        name: `nlapi-v1-${stamp}`, providerId, visibility: "public", transport: "phone",
        config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-1234"\n', stepsSuffix: "- type: call.hangup\n" },
      }),
    });
    expect(created.status).toBe(200);
    flowIds.push(created.body.id);
    // An answer for the number the flow dials now (…1234).
    const stale = { value: "twilio", carrierName: "Twilio", lineType: "nonFixedVoip", lookedUpAt: "2026-10-22T00:00:00.000Z", number: "…1234" };
    await pool.query("UPDATE eval_flows SET line_lookup = $2::jsonb WHERE id = $1", [created.body.id, JSON.stringify(stale)]);

    // Same number through v1: the answer still describes it — kept.
    const same = await jsonFetch(`${BASE_URL}/api/v1/eval-flows/${created.body.id}`, {
      method: "PUT", cookie: users[0].cookie, body: JSON.stringify({ description: "unchanged number" }),
    });
    expect(same.status).toBe(200);
    expect((await storage.getEvalFlow(created.body.id))!.lineLookup).toEqual(stale);

    // New number, no credentials configured: the old answer is for a number
    // the flow no longer dials — cleared, not frozen onto future jobs.
    const put = await jsonFetch(`${BASE_URL}/api/v1/eval-flows/${created.body.id}`, {
      method: "PUT", cookie: users[0].cookie,
      body: JSON.stringify({ config: { stepsPrefix: '- type: call.dial\n  number: "+1 (555) 010-9876"\n', stepsSuffix: "- type: call.hangup\n" } }),
    });
    expect(put.status).toBe(200);
    // Answered before the lookup: the current (stale) answer + pending…
    expect(put.body.data.lineLookupPending).toBe(true);
    // …and the background lookup then clears it.
    let after: unknown = stale;
    for (let i = 0; i < 50 && after !== null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = (await storage.getEvalFlow(created.body.id))!.lineLookup;
    }
    expect(after).toBeNull();
  });

  it("Look up again: editors only, reports why it was skipped", async () => {
    const id = flowIds[0];
    const url = `${BASE_URL}/api/eval-flows/${id}/line-lookup`;
    expect((await jsonFetch(url, { method: "POST" })).status).toBe(401);
    expect((await jsonFetch(url, { method: "POST", cookie: users[1].cookie })).status).toBe(403);
    // Admins are not flow editors.
    expect((await jsonFetch(url, { method: "POST", cookie: adminCookie })).status).toBe(403);
    const own = await jsonFetch(url, { method: "POST", cookie: users[0].cookie });
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ skipped: "not-configured" });
    expect((await jsonFetch(`${BASE_URL}/api/eval-flows/999999999/line-lookup`, { method: "POST", cookie: users[0].cookie })).status).toBe(404);

    const web = await jsonFetch(`${BASE_URL}/api/eval-flows`, {
      method: "POST", cookie: users[0].cookie,
      body: JSON.stringify({ name: `nlapi-web-${stamp}`, providerId, visibility: "public" }),
    });
    flowIds.push(web.body.id);
    expect((await jsonFetch(`${BASE_URL}/api/eval-flows/${web.body.id}/line-lookup`, { method: "POST", cookie: users[0].cookie })).status).toBe(400);
  });
});
