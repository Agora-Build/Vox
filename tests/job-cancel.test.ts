import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../server/storage";
import { BASE_NA } from "./helpers/regions";

// Cancelling a PENDING job from the console. The cancel rule and route already
// existed (canCancelJob, DELETE /api/eval-jobs/:id) but nothing in the
// console called them, a cancelled job read as a red "Failed", and a paid
// job's held credits only came back at the next settlement sweep. Now: the job
// page offers Cancel when the server says this user may; the job records who
// cancelled it (cancelled_by/at — status stays 'failed'); a paid hold is
// released at once. A running job can't be cancelled (out of scope by design).

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;

const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  });
const bearer = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
  });

d("cancelling a pending job", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const emails: string[] = [];
  const tokenIds: number[] = [];
  let admin = "";
  let providerId = "";

  async function user(label: string): Promise<{ id: number; cookie: string }> {
    const email = `cancel-${label}-${stamp}@example.com`;
    emails.push(email);
    const { token } = await (await call(admin, "POST", "/api/admin/invite", { email, plan: "premium" })).json();
    expect((await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `cancel${label}${stamp}`, password: "TestPass123!", token }),
    })).ok).toBe(true);
    const id = (await pool.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as number;
    const cookie = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123!" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    return { id, cookie };
  }
  /**
   * A public eval flow + eval set of `who`'s, and a pending job on them (via
   * the real run route). The PRIVATE pool by default: `who` has no agents, so
   * nothing can claim it mid-test (the dev env's own public agent would).
   */
  async function pendingJob(who: { cookie: string }, run: Record<string, unknown> = { targetTier: "private", region: BASE_NA }): Promise<number> {
    const flow = await (await call(who.cookie, "POST", "/api/eval-flows", {
      name: `cancel-flow-${stamp}-${Math.random()}`, providerId, visibility: "public", config: { framework: "aeval" },
    })).json();
    const set = await (await call(who.cookie, "POST", "/api/eval-sets", { name: `cancel-set-${stamp}-${Math.random()}`, config: {} })).json();
    const res = await call(who.cookie, "POST", `/api/eval-flows/${flow.id}/run`, { evalSetId: set.id, ...run });
    expect(res.status).toBe(200);
    return (await res.json()).job.id;
  }
  const detail = async (cookie: string, id: number) => (await call(cookie, "GET", `/api/eval-jobs/${id}/detail`)).json();
  const balance = async (cookie: string) => (await (await call(cookie, "GET", "/api/plugins/credits/balance")).json()).credits as number;

  beforeAll(async () => {
    admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    })).headers.get("set-cookie") || "").split(";")[0];
    providerId = (await (await fetch(`${BASE_URL}/api/providers`)).json())[0].id;
  });

  afterAll(async () => {
    for (const id of tokenIds) await call(admin, "POST", `/api/eval-agent-tokens/${id}/revoke`);
    const ids = (await pool.query("SELECT id FROM users WHERE email = ANY($1)", [emails])).rows.map((r) => r.id);
    if (!ids.length) return;
    await pool.query("DELETE FROM eval_jobs WHERE created_by = ANY($1)", [ids]);
    await pool.query("DELETE FROM eval_flows WHERE owner_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM eval_sets WHERE owner_id = ANY($1)", [ids]);
  });

  it("its runner sees Cancel, cancels it, and the job then shows who cancelled it", async () => {
    const me = await user("runner");
    const id = await pendingJob(me);
    expect((await detail(me.cookie, id)).canCancel).toBe(true);

    expect((await call(me.cookie, "DELETE", `/api/eval-jobs/${id}`)).status).toBe(200);

    const after = await detail(me.cookie, id);
    expect(after.job).toMatchObject({ status: "failed", error: "Cancelled by user", cancelledBy: me.id });
    expect(after.job.cancelledAt).not.toBeNull();
    expect(after.cancelledByName).toBe(`cancelrunner${stamp}`);
    expect(after.canCancel).toBe(false); // no longer pending
    expect(after.waiting).toBeNull();
    // Cancelling again is refused, and changes nothing.
    expect((await call(me.cookie, "DELETE", `/api/eval-jobs/${id}`)).status).toBe(400);
  });

  it("someone who can view the job but may not act on it gets no Cancel, and is refused", async () => {
    const owner = await user("owner");
    const viewer = await user("viewer");
    const id = await pendingJob(owner); // a public flow: any signed-in user may view the job
    const asViewer = await detail(viewer.cookie, id);
    expect(asViewer.job.id).toBe(id);
    expect(asViewer.canCancel).toBe(false);
    expect((await call(viewer.cookie, "DELETE", `/api/eval-jobs/${id}`)).status).toBe(403);
    expect((await detail(owner.cookie, id)).job.status).toBe("pending");
  });

  it("a running job can't be cancelled", async () => {
    const me = await user("running");
    const id = await pendingJob(me);
    await pool.query("UPDATE eval_jobs SET status = 'running', started_at = now() WHERE id = $1", [id]);
    expect((await detail(me.cookie, id)).canCancel).toBe(false);
    expect((await call(me.cookie, "DELETE", `/api/eval-jobs/${id}`)).status).toBe(400);
    expect((await detail(me.cookie, id)).job).toMatchObject({ status: "running", cancelledAt: null });
  });

  it("the API (DELETE /api/v1/jobs/:id) records who cancelled it too", async () => {
    const me = await user("api");
    const id = await pendingJob(me);
    expect((await call(me.cookie, "DELETE", `/api/v1/jobs/${id}`)).status).toBe(200);
    expect((await detail(me.cookie, id)).job).toMatchObject({ status: "failed", cancelledBy: me.id });
  });

  it("a paid job's held credits come back at once, not at the next settlement sweep", async () => {
    const PRICE = 10;
    const operator = await user("operator");
    const renter = await user("renter");
    // The operator's agent, trusted and listed on the marketplace.
    const tok = await (await call(operator.cookie, "POST", "/api/eval-agent-tokens", { name: `cancel-paid-${stamp}`, dispatchTier: "private" })).json();
    tokenIds.push(tok.id);
    const agent = await (await bearer(tok.token, "POST", "/api/eval-agent/register", { name: `cancel-paid-${stamp}` })).json();
    await pool.query("UPDATE eval_agents SET region = $1, site_id = $2, location_trust = 'trusted' WHERE id = $3", [BASE_NA, `${BASE_NA}-77`, agent.id]);
    expect((await call(operator.cookie, "PATCH", `/api/eval-agent-tokens/${tok.id}`, { dispatchTier: "shared", pricePerUnit: PRICE })).ok).toBe(true);

    const before = await balance(renter.cookie);
    const id = await pendingJob(renter, { targetTokenId: tok.id });
    const held = await balance(renter.cookie);
    expect(held).toBeLessThan(before); // the hold

    expect((await call(renter.cookie, "DELETE", `/api/eval-jobs/${id}`)).status).toBe(200);
    expect(await balance(renter.cookie)).toBe(before); // refunded now — no sweep waited for
    const row = (await pool.query("SELECT settlement_done_at FROM eval_jobs WHERE id = $1", [id])).rows[0];
    expect(row.settlement_done_at).not.toBeNull(); // and kept out of the sweep
  });
});
