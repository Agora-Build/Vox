import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/storage";
import { evalAgents } from "../shared/schema";
import { BASE_NA } from "./helpers/regions";

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

describe("register/heartbeat location detection", () => {
  let cookie: string; let tokenSecret: string; let tokenId: number; let agentId: number; let leaseId: string;

  beforeAll(async () => {
    cookie = await login();
    const res = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-reg-${Date.now()}`, dispatchTier: "private" }),
    });
    const body = await res.json();
    tokenSecret = body.token; tokenId = body.id;
  });
  afterAll(async () => {
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${tokenId}/revoke`, { method: "POST" });
  });

  const agentFetch = (url: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}${url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("register runs detection: localhost → unknown, siteId null, Unverified", async () => {
    const res = await agentFetch("/api/eval-agent/register", { name: "zt-agent" });
    expect(res.status).toBe(200);
    const agent = await res.json();
    agentId = agent.id; leaseId = agent.leaseId;
    expect(agent.siteId).toBeNull();
    expect(agent.region).toBeNull();
    expect(agent.locationTrust).toBe("unknown"); // dev connects via 127.0.0.1
  });

  it("heartbeat keeps working for an Unverified agent", async () => {
    const res = await agentFetch("/api/eval-agent/heartbeat", { agentId, leaseId, state: "idle" });
    expect(res.status).toBe(200);
  });

  it("/api/eval-agents exposes locationTrust but never location_source", async () => {
    const list = await (await authFetch(cookie, `${BASE_URL}/api/eval-agents`)).json();
    const mine = list.find((a: { id: number }) => a.id === agentId);
    expect(mine).toBeDefined();
    expect(mine.locationTrust).toBe("unknown");
    expect(mine.region).toBeNull();
    expect(mine).not.toHaveProperty("locationSource");
    expect(mine).not.toHaveProperty("observedIp");
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("run-targets: two-level tree fields (Task 12)", () => {
  let cookie: string;
  let workflowId: number;
  let evalSetId: number;
  let privateTokenId: number;
  let sharedTokenId: number;
  let publicTokenId: number;
  let publicSiteId: string;

  beforeAll(async () => {
    cookie = await login();

    const providers = await (await authFetch(cookie, `${BASE_URL}/api/providers`)).json();
    const providerId = providers[0].id;
    const wfRes = await authFetch(cookie, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-rt-wf-${Date.now()}`, visibility: "public", providerId, config: {} }),
    });
    expect(wfRes.ok).toBe(true);
    workflowId = (await wfRes.json()).id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;

    // A private token whose agent registers and lands Unverified (localhost →
    // "unknown" trust, siteId null) — exercises the "mine" row shape.
    const privRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-rt-priv-${Date.now()}`, dispatchTier: "private" }),
    });
    expect(privRes.ok).toBe(true);
    const privBody = await privRes.json();
    privateTokenId = privBody.id;
    const privRegRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privBody.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zt-rt-priv-agent" }),
    });
    expect(privRegRes.ok).toBe(true);

    // A shared agent that goes Unverified after listing — must never appear
    // in the shared marketplace list (not dispatchable at all), even though
    // its (stale) listing region is still non-null. A "shared" dispatchTier
    // token can only be minted with a region already attached (the plugin's
    // `listings.region` column is NOT NULL), so: mint public (gets a site),
    // register (agent inherits the site), flip to shared via PATCH, then
    // directly null the agent's detected siteId — simulating a live
    // re-detection dropping it to Unverified without the listing following.
    const sharedRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-rt-shared-${Date.now()}`, regionLocationBaseId: BASE_NA, dispatchTier: "public" }),
    });
    expect(sharedRes.ok).toBe(true);
    const sharedBody = await sharedRes.json();
    sharedTokenId = sharedBody.id;
    const sharedRegRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sharedBody.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zt-rt-shared-agent" }),
    });
    expect(sharedRegRes.ok).toBe(true);
    const patchRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${sharedTokenId}`, {
      method: "PATCH",
      body: JSON.stringify({ dispatchTier: "shared", pricePerUnit: 5 }),
    });
    expect(patchRes.ok).toBe(true);
    await db.update(evalAgents).set({ siteId: null, locationTrust: "anonymized" }).where(eq(evalAgents.tokenId, sharedTokenId));

    // A plain public-tier token, left as public (never patched) — exercises
    // the informational `agents.public` fleet row, whose region/siteId must
    // come from the TOKEN (public's own detected agent.region is always
    // null; effectiveDispatchIdentity sources public identity from the token).
    const pubRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-rt-pub-${Date.now()}`, regionLocationBaseId: BASE_NA, dispatchTier: "public" }),
    });
    expect(pubRes.ok).toBe(true);
    const pubBody = await pubRes.json();
    publicTokenId = pubBody.id;
    publicSiteId = pubBody.siteId;
    const pubRegRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pubBody.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zt-rt-pub-agent" }),
    });
    expect(pubRegRes.ok).toBe(true);
  });

  afterAll(async () => {
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${privateTokenId}/revoke`, { method: "POST" });
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${sharedTokenId}/revoke`, { method: "POST" });
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${publicTokenId}/revoke`, { method: "POST" });
    await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}`, { method: "DELETE" });
  });

  it("every agent row carries siteId/region/dispatchTier/locationTrust, with no locationSource/observedIp leak", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run-targets?evalSetId=${evalSetId}`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    const mine = body.agents.mine.find((a: { tokenId: number }) => a.tokenId === privateTokenId);
    expect(mine).toBeDefined();
    expect(mine).toHaveProperty("siteId");
    expect(mine).toHaveProperty("region");
    expect(mine).toHaveProperty("dispatchTier");
    expect(mine).toHaveProperty("locationTrust");
    expect(mine.dispatchTier).toBe("private");
    expect(mine.siteId).toBeNull();
    expect(mine.region).toBeNull();
    expect(mine.locationTrust).toBe("unknown");

    for (const row of [...body.agents.mine, ...body.agents.shared]) {
      expect(row).toHaveProperty("siteId");
      expect(row).toHaveProperty("region");
      expect(row).toHaveProperty("dispatchTier");
      expect(row).toHaveProperty("locationTrust");
      expect(row).not.toHaveProperty("locationSource");
      expect(row).not.toHaveProperty("observedIp");
    }
  });

  it("shared agents with siteId null (Unverified) are filtered out server-side", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run-targets?evalSetId=${evalSetId}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.agents.shared.find((a: { tokenId: number }) => a.tokenId === sharedTokenId)).toBeUndefined();
    // Also never smuggled through under "mine" (the token is admin-owned too).
    expect(body.agents.mine.find((a: { tokenId: number }) => a.tokenId === sharedTokenId)).toBeUndefined();
  });

  it("agents.public carries token-sourced region/siteId+state, no tokenId, and no locationSource/observedIp leak", async () => {
    const res = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run-targets?evalSetId=${evalSetId}`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    expect(Array.isArray(body.agents.public)).toBe(true);
    const row = body.agents.public.find((r: { siteId: string }) => r.siteId === publicSiteId);
    expect(row).toBeDefined();
    // Region comes from the TOKEN (BASE_NA), never the agent's own detected
    // region — which is permanently null for public-tier agents.
    expect(row.region).toBe(BASE_NA);
    expect(row.siteId).toBe(publicSiteId);
    expect(typeof row.state).toBe("string");
    // Never individually targetable: no tokenId on the informational row.
    expect(row).not.toHaveProperty("tokenId");
    expect(row).not.toHaveProperty("name");

    for (const r of body.agents.public) {
      expect(r).not.toHaveProperty("locationSource");
      expect(r).not.toHaveProperty("observedIp");
    }

    // The admin's own public token must not be duplicated under "mine" —
    // public sites are represented exactly once, via agents.public.
    expect(body.agents.mine.find((a: { tokenId: number }) => a.tokenId === publicTokenId)).toBeUndefined();
  });
});
