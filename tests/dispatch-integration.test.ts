import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

// Create a token for an already-allocated region base, then register an agent that presents it.
// The create-token response carries the plaintext token, the numeric id, AND the resolved
// site region (e.g. "apac-in-mumbai-01") directly — no need to list tokens and match by name.
async function makeTokenAndAgent(cookie: string, name: string, regionBaseId: string) {
  const tRes = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
    method: "POST",
    body: JSON.stringify({ name, regionLocationBaseId: regionBaseId, visibility: "public" }),
  });
  expect(tRes.ok).toBe(true);
  const created = await tRes.json(); // { id, name, token, region, visibility, createdAt }

  const rRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, metadata: { frameworkVersion: "0.0.0" } }),
  });
  expect(rRes.ok).toBe(true);
  // { id, region, state, leaseId, ... } — registration issues a fresh per-process
  // lease; claim/complete fence out a superseded lease by requiring it back in the body.
  const agent = await rRes.json();

  return { id: created.id as number, token: created.token as string, region: created.region as string, agent };
}

describe("targeted dispatch isolation", () => {
  let cookie: string;
  let workflowId: number;
  let evalSetId: number;
  let regionBaseIds: string[];

  beforeAll(async () => {
    cookie = await login();

    const regions = await (await authFetch(cookie, `${BASE_URL}/api/region-locations`)).json();
    regionBaseIds = regions
      .filter((r: any) => r.isActive)
      .map((r: any) => r.baseId as string);
    expect(regionBaseIds.length).toBeGreaterThanOrEqual(2);

    // includePublic=true: admin owns no workflows/eval-sets by default in a fresh
    // seed — the runnable seed content (mainline LiveKit workflow, basic eval set)
    // is owned by Scout but public, so admin needs the public-merge view to see it.
    const wf = await (await authFetch(cookie, `${BASE_URL}/api/workflows?includePublic=true`)).json();
    workflowId = wf[0].id;
    const es = await (await authFetch(cookie, `${BASE_URL}/api/eval-sets?includePublic=true`)).json();
    evalSetId = es[0].id;
  });

  it("a targeted job is visible/claimable ONLY to the aimed token's agent", async () => {
    // Two DIFFERENT active bases — two tokens on the SAME base would get different
    // sequential site ids (base-01, base-02) purely from sequence allocation, which
    // would not actually prove region isolation. Different bases are unambiguous.
    const [baseA, baseB] = regionBaseIds;
    const A = await makeTokenAndAgent(cookie, `agent-A-${Date.now()}`, baseA);
    const B = await makeTokenAndAgent(cookie, `agent-B-${Date.now()}`, baseB);
    expect(A.region).not.toBe(B.region);

    // Dispatch ONE job targeted at token A. The run route derives the job's region
    // from the target token and ignores any body `region`.
    const runRes = await authFetch(cookie, `${BASE_URL}/api/workflows/${workflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ evalSetId, targetTokenId: A.id }),
    });
    expect(runRes.ok).toBe(true);

    // --- Positive: A sees and can claim the targeted job. ---
    const aJobs = await (await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
      headers: { Authorization: `Bearer ${A.token}` },
    })).json();
    const targeted = aJobs.find((j: any) => j.targetTokenId === A.id);
    expect(targeted).toBeDefined();
    expect(targeted.region).toBe(A.region);

    const claim = await fetch(`${BASE_URL}/api/eval-agent/jobs/${targeted.id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${A.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: A.agent.id, leaseId: A.agent.leaseId }),
    });
    expect(claim.ok).toBe(true);

    // --- Negative: B never sees the job targeted at A. ---
    const bJobs = await (await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
      headers: { Authorization: `Bearer ${B.token}` },
    })).json();
    // B is a different token in a different region: the targeted job must not leak to it.
    // This asserts no cross-token leak (region AND target both differ); the precise
    // same-region target-vs-untargeted semantics are proven by tests/permissions-dispatch.test.ts.
    expect(bJobs.find((j: any) => j.targetTokenId === A.id)).toBeUndefined();
  });
});
