import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../server/storage";

// #209: the admin Users list returned (and the page rendered) every user at
// once — 5,485 on the dev DB froze the browser past 15 s. It now returns one
// page, newest first, with a search and the summary counts computed in SQL.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

d("#209 admin users list is paginated", () => {
  let admin = "";
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const emails = [`pageuser-a-${stamp}@example.com`, `pageuser-b-${stamp}@example.com`, `pageuser-c-${stamp}@example.com`];
  const list = async (q: Record<string, string> = {}) => {
    const res = await fetch(`${BASE_URL}/api/admin/users?${new URLSearchParams(q)}`, { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ data: Array<{ id: number; email: string; createdAt: string }>; total: number; stats: { total: number; admins: number; premium: number } }>;
  };

  beforeAll(async () => {
    admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    for (const email of emails) {
      const { token } = await (await fetch(`${BASE_URL}/api/admin/invite`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ email, plan: "premium" }),
      })).json();
      await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: email.split("@")[0].replace(/-/g, ""), password: "TestPass123!", token }),
      });
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE email = ANY($1)", [emails]);
  });

  it("returns one page, newest first, with the total", async () => {
    const page = await list({ limit: "2" });
    expect(page.data).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(new Date(page.data[0].createdAt) >= new Date(page.data[1].createdAt)).toBe(true);
    const next = await list({ limit: "2", offset: "2" });
    expect(next.data.map((u) => u.id)).not.toContain(page.data[0].id);
  });

  it("defaults to a bounded page, and caps a huge limit", async () => {
    expect((await list()).data.length).toBeLessThanOrEqual(50);
    expect((await list({ limit: "100000" })).data.length).toBeLessThanOrEqual(200);
  });

  it("searches by email or username, case-insensitively", async () => {
    const found = await list({ q: `PAGEUSER-B-${stamp}` });
    expect(found.total).toBe(1);
    expect(found.data[0].email).toBe(emails[1]);
    expect((await list({ q: stamp })).total).toBe(3);
  });

  it("counts across all users, not the page", async () => {
    const { stats, total } = await list({ limit: "1" });
    expect(stats.total).toBe(total);
    const real = (await pool.query(
      "SELECT count(*)::int total, count(*) FILTER (WHERE is_admin)::int admins, count(*) FILTER (WHERE plan = 'premium')::int premium FROM users",
    )).rows[0];
    expect(stats).toEqual(real);
  });

  it("rejects a bad page request", async () => {
    for (const q of [{ limit: "0" }, { limit: "x" }, { offset: "-1" }]) {
      const res = await fetch(`${BASE_URL}/api/admin/users?${new URLSearchParams(q)}`, { headers: { Cookie: admin } });
      expect(res.status).toBe(400);
    }
  });
});
