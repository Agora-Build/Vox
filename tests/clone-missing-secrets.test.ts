import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../server/storage";

// #130: cloning an eval flow copies its ${secrets.X} references but not the
// values (secrets resolve in the owner's scope), so a clone was born unrunnable
// and nothing said so. The clone response, the eval flow list and the detail
// page now name what's missing — to whoever can fix it, and only to them.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  });

d("#130 a clone says which secrets its new owner must create", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const KEY = `CLONE_KEY_${stamp}`;
  const OTHER = `CLONE_OTHER_${stamp}`;
  const emails = [`clone-author-${stamp}@example.com`, `clone-cloner-${stamp}@example.com`];
  let author = "";
  let cloner = "";
  let sourceId = 0;

  async function user(email: string): Promise<string> {
    const admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    const { token } = await (await call(admin, "POST", "/api/admin/invite", { email, plan: "premium" })).json();
    expect((await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email.split("@")[0].replace(/-/g, ""), password: "TestPass123!", token }),
    })).ok).toBe(true);
    return ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123!" }),
    })).headers.get("set-cookie") || "").split(";")[0];
  }

  beforeAll(async () => {
    author = await user(emails[0]);
    cloner = await user(emails[1]);
    // The author has both secrets; the flow's Setup uses both.
    for (const name of [KEY, OTHER]) {
      expect((await call(author, "POST", "/api/secrets", { name, value: `value-of-${name}` })).ok).toBe(true);
    }
    const providerId = (await (await fetch(`${BASE_URL}/api/providers`)).json())[0].id;
    const res = await call(author, "POST", "/api/eval-flows", {
      name: `clone-source-${stamp}`, providerId, visibility: "public",
      config: { framework: "aeval", stepsPrefix: `- type: control.log\n  message: \${secrets.${KEY}} \${secrets.${OTHER}}\n` },
    });
    expect(res.ok).toBe(true);
    sourceId = (await res.json()).id;
  });

  afterAll(async () => {
    const ids = (await pool.query("SELECT id FROM users WHERE email = ANY($1)", [emails])).rows.map((r) => r.id);
    if (!ids.length) return;
    await pool.query("DELETE FROM eval_flows WHERE owner_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM secrets WHERE user_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  });

  it("the author's own flow has nothing missing", async () => {
    const detail = await (await call(author, "GET", `/api/eval-flows/${sourceId}`)).json();
    expect(detail.missingSecrets).toEqual([]);
  });

  it("the clone response names the secrets the cloner doesn't have", async () => {
    const res = await call(cloner, "POST", `/api/eval-flows/${sourceId}/clone`);
    expect(res.ok).toBe(true);
    const clone = await res.json();
    expect(clone.missingSecrets).toEqual([KEY, OTHER].sort());

    // The list and the detail page say the same, until the cloner creates them.
    const listed = (await (await call(cloner, "GET", "/api/eval-flows")).json()).find((f: { id: number }) => f.id === clone.id);
    expect(listed.missingSecrets).toEqual([KEY, OTHER].sort());
    expect((await call(cloner, "POST", "/api/secrets", { name: KEY, value: "my-own-value" })).ok).toBe(true);
    expect((await (await call(cloner, "GET", `/api/eval-flows/${clone.id}`)).json()).missingSecrets).toEqual([OTHER]);
    expect((await call(cloner, "POST", "/api/secrets", { name: OTHER, value: "my-other-value" })).ok).toBe(true);
    expect((await (await call(cloner, "GET", `/api/eval-flows/${clone.id}`)).json()).missingSecrets).toEqual([]);
  });

  it("someone else's flow carries no missing-secrets field: not theirs to fix, nor to know", async () => {
    expect((await (await call(cloner, "GET", `/api/eval-flows/${sourceId}`)).json())).not.toHaveProperty("missingSecrets");
    const listed = (await (await call(cloner, "GET", "/api/eval-flows?includePublic=true")).json()).find((f: { id: number }) => f.id === sourceId);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("missingSecrets");
  });
});
