import { describe, it, expect, beforeAll } from "vitest";
import { storage, pool } from "../server/storage";

// #93: revoking an eval-agent token left its marketplace listing active, so a
// revoked shared agent kept being offered in GET /api/eval-agents/dispatchable
// (renters only hit a 404 at the run route).
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)("revoked tokens leave the marketplace", () => {
  let cookie = "";
  let base = "";
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${BASE_URL}${path}`, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // The listing row itself, not just what the list endpoint shows (which also
  // filters revoked tokens and would hide a revoke that forgot to unlist).
  const listingActive = async (tokenId: number) =>
    (await pool.query("SELECT active FROM plugin_shared_agents.listings WHERE token_id = $1", [tokenId])).rows[0]?.active;
  const listed = async (tokenId: number) =>
    ((await (await call("GET", "/api/eval-agents/dispatchable")).json()).shared as Array<{ tokenId: number }>)
      .some((a) => a.tokenId === tokenId);

  /** A registered token put up for sale — listed on the marketplace. */
  async function sharedToken(): Promise<number> {
    const t = await (await call("POST", "/api/eval-agent-tokens", {
      name: `revoke-listing-${Date.now()}-${Math.random()}`, regionLocationBaseId: base, dispatchTier: "public",
    })).json();
    const reg = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "revoke-listing-agent" }),
    });
    expect(reg.ok).toBe(true);
    expect((await call("PATCH", `/api/eval-agent-tokens/${t.id}`, { dispatchTier: "shared", pricePerUnit: 5 })).ok).toBe(true);
    expect(await listed(t.id)).toBe(true); // control: it really is for sale
    return t.id;
  }

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
    });
    cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    const regions = await (await fetch(`${BASE_URL}/api/region-locations`)).json();
    base = regions[0].baseId;
  });

  it("the owner's revoke takes the token off sale", async () => {
    const id = await sharedToken();
    expect((await call("POST", `/api/eval-agent-tokens/${id}/revoke`)).ok).toBe(true);
    expect(await listingActive(id)).toBe(false);
    expect(await listed(id)).toBe(false);
  });

  it("the admin revoke does too", async () => {
    const id = await sharedToken();
    expect((await call("POST", `/api/admin/eval-agent-tokens/${id}/revoke`)).ok).toBe(true);
    expect(await listingActive(id)).toBe(false);
    expect(await listed(id)).toBe(false);
  });

  it("a listing left active by an older revoke is not offered either", async () => {
    const id = await sharedToken();
    await storage.revokeEvalAgentToken(id); // revoked without unlisting, as before the fix
    expect(await listingActive(id)).toBe(true); // the stale listing really is there
    expect(await listed(id)).toBe(false);
  });

  it("an expired token is not offered either", async () => {
    const id = await sharedToken();
    await pool.query("UPDATE eval_agent_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(await listed(id)).toBe(false);
  });
});
