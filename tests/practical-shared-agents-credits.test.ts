import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { BASE_NA, BASE_EU } from "./helpers/regions";
import { computeCharge, computeFee, PLATFORM_FEE_BPS } from "../plugins/shared-agents/server/pricing";

// =====================================================================
// Task 13: Practical end-to-end tests — shared-agents marketplace + credits
//
// Real HTTP + real Postgres against the plugin-enabled local dev server
// (VOX_PLUGINS=credits,shared-agents). No mocks: every dollar (credit) moved
// here is observed through the same balance/statement HTTP surface a real
// client would use, and every dispatch goes through the real
// /api/workflows/:id/run + /api/eval-agent/* HTTP flow.
//
// Requires: local dev server running (./scripts/dev-local-run.sh start)
// with both plugins loaded — confirmed in setup via /api/eval-agents/dispatchable.
// =====================================================================

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

// Direct-DB reads are allowed for OBSERVING money legs the HTTP surface doesn't
// expose (e.g. the platform-fee account has no balance route) — never used to
// fabricate or mutate state. Same pool style as tests/credits-e2e.test.ts.
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Every eval-agent token this suite creates, so afterAll can revoke them and
// keep dev-DB listing growth bounded (Task 13 review minor 8).
const createdTokenIds: number[] = [];

interface AuthSession { cookie: string }

async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie");
  return { cookie: setCookie.split(";")[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: session.cookie, "Content-Type": "application/json" },
  });
}

function bearerFetch(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Register a fresh user via the real admin-invite → register → login flow
// (tests/api.test.ts idiom) so every scenario runs against a real account,
// never a fabricated session.
async function makeUser(admin: AuthSession, plan: "premium" | "basic", label: string, stamp: string): Promise<{ session: AuthSession; id: number; email: string }> {
  const email = `t13-${label}-${stamp}@test.local`;
  const inviteRes = await authFetch(admin, `${BASE_URL}/api/admin/invite`, {
    method: "POST", body: JSON.stringify({ email, plan }),
  });
  expect(inviteRes.ok).toBe(true);
  const { token } = await inviteRes.json();
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `t13-${label}-${stamp}`, password: "t13-pass-123", token }),
  });
  expect(regRes.ok).toBe(true);
  const { user } = await regRes.json();
  const session = await login(email, "t13-pass-123");
  return { session, id: user.id, email };
}

async function getBalance(session: AuthSession): Promise<number> {
  const res = await authFetch(session, `${BASE_URL}/api/plugins/credits/balance`);
  expect(res.ok).toBe(true);
  const body = await res.json();
  return body.credits as number;
}

async function getStatement(session: AuthSession, limit = 20): Promise<Array<{ id: number; amount: number; reason: string; groupId: string; refType: string | null; refId: string | null }>> {
  const res = await authFetch(session, `${BASE_URL}/api/plugins/credits/statement?limit=${limit}`);
  expect(res.ok).toBe(true);
  const body = await res.json();
  return body.entries;
}

async function deposit(admin: AuthSession, userId: number, credits: number, idempotencyKey: string, reason = "task13-grant"): Promise<Response> {
  return authFetch(admin, `${BASE_URL}/api/plugins/credits/grants`, {
    method: "POST", body: JSON.stringify({ userId, credits, reason, idempotencyKey }),
  });
}

async function createToken(session: AuthSession, name: string, regionLocationBaseId: string): Promise<{ id: number; token: string; region: string }> {
  const res = await authFetch(session, `${BASE_URL}/api/eval-agent-tokens`, {
    method: "POST", body: JSON.stringify({ name, regionLocationBaseId, visibility: "private" }),
  });
  expect(res.ok).toBe(true);
  const body = await res.json();
  createdTokenIds.push(body.id);
  return { id: body.id, token: body.token, region: body.siteId };
}

async function setDispatchTier(session: AuthSession, tokenId: number, dispatchTier: string, pricePerUnit?: number): Promise<Response> {
  return authFetch(session, `${BASE_URL}/api/eval-agent-tokens/${tokenId}`, {
    method: "PATCH", body: JSON.stringify({ dispatchTier, ...(pricePerUnit !== undefined ? { pricePerUnit } : {}) }),
  });
}

async function registerAgent(tokenPlain: string, name: string, metadata: Record<string, unknown> = {}): Promise<{ id: number; leaseId: string; region: string }> {
  const res = await bearerFetch(tokenPlain, "POST", "/api/eval-agent/register", { name, metadata });
  expect(res.ok).toBe(true);
  return res.json();
}

async function claimTargeted(tokenPlain: string, agentId: number, leaseId: string, jobId: number): Promise<Response> {
  return bearerFetch(tokenPlain, "POST", `/api/eval-agent/jobs/${jobId}/claim`, { agentId, leaseId });
}

async function findJob(tokenPlain: string, jobId: number): Promise<{ id: number; targetTokenId: number | null; config: Record<string, unknown> } | undefined> {
  const res = await bearerFetch(tokenPlain, "GET", "/api/eval-agent/jobs");
  expect(res.ok).toBe(true);
  const jobs = await res.json();
  return jobs.find((j: { id: number }) => j.id === jobId);
}

const SAMPLE_RESULTS = {
  responseLatencyMedian: 900, responseLatencySd: 80,
  interruptLatencyMedian: 850, interruptLatencySd: 60,
  responseRate: 0.95, interruptRate: 0.9, falseInterruptRate: 0.05, turnSuccessRate: 0.93,
  networkResilience: 88, naturalness: 4.2, noiseReduction: 91,
};

async function completeJob(tokenPlain: string, agentId: number, leaseId: string, jobId: number, extra: Record<string, unknown>): Promise<Response> {
  return bearerFetch(tokenPlain, "POST", `/api/eval-agent/jobs/${jobId}/complete`, { agentId, leaseId, ...extra });
}

async function createWorkflow(session: AuthSession, name: string, providerId: string, config: Record<string, unknown> = { framework: "aeval" }): Promise<number> {
  const res = await authFetch(session, `${BASE_URL}/api/workflows`, {
    method: "POST", body: JSON.stringify({ name, providerId, config }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()).id;
}

async function createEvalSet(session: AuthSession, name: string, config: Record<string, unknown> = {}): Promise<number> {
  const res = await authFetch(session, `${BASE_URL}/api/eval-sets`, {
    method: "POST", body: JSON.stringify({ name, config }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()).id;
}

async function createSecret(
  session: AuthSession, name: string, value: string,
  opts?: { brokerType?: string | null; isTestAccount?: boolean },
): Promise<void> {
  const res = await authFetch(session, `${BASE_URL}/api/secrets`, {
    method: "POST", body: JSON.stringify({ name, value, ...opts }),
  });
  expect(res.ok).toBe(true);
}

async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 150_000, intervalMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("Task 13: practical shared-agents marketplace + credits e2e", () => {
  let admin: AuthSession;
  let owner: { session: AuthSession; id: number };
  let rich: { session: AuthSession; id: number };
  let broke: { session: AuthSession; id: number };
  let providerId: string;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    // Confirm both plugins are actually active in this running server (the
    // brief's non-negotiable: the reap-settle worker + marketplace seam must
    // be live, not just present in the codebase). free/shared shape proves
    // the vox.eval-marketplace seam resolved.
    const dispatchableRes = await authFetch(admin, `${BASE_URL}/api/eval-agents/dispatchable`);
    expect(dispatchableRes.ok).toBe(true);
    const dispatchable = await dispatchableRes.json();
    expect(Array.isArray(dispatchable.free)).toBe(true);
    expect(Array.isArray(dispatchable.shared)).toBe(true);

    const owner_ = await makeUser(admin, "premium", "owner", stamp);
    const rich_ = await makeUser(admin, "premium", "rich", stamp);
    const broke_ = await makeUser(admin, "premium", "broke", stamp);
    owner = owner_; rich = rich_; broke = broke_;

    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    providerId = providers[0].id;
  });

  afterAll(async () => {
    // Revoke every eval-agent token this suite created (admin can revoke any
    // token) so repeated local runs don't grow the token list unbounded.
    for (const id of createdTokenIds) {
      await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens/${id}/revoke`, { method: "POST" });
    }
    await dbPool.end();
  });

  // ── 1. Credits basics ────────────────────────────────────────────────
  describe("1. Credits basics: grant, balance, statement, idempotent re-grant", () => {
    const idemKey = `t13-basics-${stamp}`;

    it("admin deposits credits to the dispatcher account; balance and statement reflect it", async () => {
      const before = await getBalance(rich.session);
      expect(before).toBe(0);

      const res = await deposit(admin, rich.id, 100_000, idemKey, "task13 basics grant");
      expect(res.status).toBe(201);

      const after = await getBalance(rich.session);
      expect(after).toBe(100_000);

      const entries = await getStatement(rich.session, 5);
      expect(entries[0].amount).toBe(100_000);
      expect(entries[0].reason).toBe("task13 basics grant");
    });

    it("repeating the same idempotencyKey does not double-credit", async () => {
      const res = await deposit(admin, rich.id, 100_000, idemKey, "task13 basics grant");
      expect(res.status).toBe(201); // idempotent success, not an error

      const balance = await getBalance(rich.session);
      expect(balance).toBe(100_000); // unchanged — no double-credit
    });
  });

  // ── 2. Paid dispatch happy path (80/20 capture) ──────────────────────
  describe("2. Paid dispatch happy path: escrow hold then 80/20 capture on completion", () => {
    const PRICE_PER_UNIT = 100;
    const charge = computeCharge(PRICE_PER_UNIT, 1);
    const fee = computeFee(charge);
    const earnerShare = charge - fee;

    let happyTokenId: number;
    let happyTokenPlain: string;
    let workflowId: number;
    let evalSetId: number;
    let happyJobId: number;

    beforeAll(async () => {
      const t = await createToken(owner.session, `t13-happy-${stamp}`, BASE_NA);
      happyTokenId = t.id; happyTokenPlain = t.token;
      const tier = await setDispatchTier(owner.session, happyTokenId, "shared", PRICE_PER_UNIT);
      expect(tier.ok).toBe(true);

      // Minor 6: prove the marketplace seam is genuinely resolved (the listing we
      // just created is actually served back), not merely array-shaped like the
      // beforeAll liveness check.
      const dispatchableRes = await authFetch(owner.session, `${BASE_URL}/api/eval-agents/dispatchable`);
      expect(dispatchableRes.ok).toBe(true);
      const dispatchable = await dispatchableRes.json();
      expect(dispatchable.shared.some((a: { tokenId: number }) => a.tokenId === happyTokenId)).toBe(true);

      workflowId = await createWorkflow(rich.session, `t13-happy-wf-${stamp}`, providerId);
      evalSetId = await createEvalSet(rich.session, `t13-happy-es-${stamp}`);
    });

    it("dispatch places an escrow hold (dispatcher balance drops by the charge)", async () => {
      const dispatcherBefore = await getBalance(rich.session);

      const runRes = await authFetch(rich.session, `${BASE_URL}/api/workflows/${workflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: happyTokenId }),
      });
      expect(runRes.status).toBe(200);
      const { job } = await runRes.json();
      happyJobId = job.id;

      const dispatcherAfterHold = await getBalance(rich.session);
      expect(dispatcherAfterHold).toBe(dispatcherBefore - charge);
    });

    it("agent claims and completes WITH results: owner nets 80%, dispatcher nets -charge", async () => {
      const jobId: number = happyJobId;
      const ownerBefore = await getBalance(owner.session);
      const dispatcherBefore = await getBalance(rich.session);

      const agent = await registerAgent(happyTokenPlain, `t13-happy-agent-${stamp}`);
      const job = await findJob(happyTokenPlain, jobId);
      expect(job).toBeDefined();
      expect(job!.targetTokenId).toBe(happyTokenId);

      const claim = await claimTargeted(happyTokenPlain, agent.id, agent.leaseId, jobId);
      expect(claim.ok).toBe(true);

      const complete = await completeJob(happyTokenPlain, agent.id, agent.leaseId, jobId, { results: SAMPLE_RESULTS });
      expect(complete.ok).toBe(true);

      // Settlement runs synchronously inside /complete but is isolated (never
      // fails the completion); the reap-settle worker is the async backstop.
      // Poll rather than assert instantly per the brief's guidance.
      const ownerAfter = await pollUntil(() => getBalance(owner.session), (b) => b === ownerBefore + earnerShare, 150_000, 5_000);
      expect(ownerAfter).toBe(ownerBefore + earnerShare); // owner +80%

      const dispatcherAfter = await getBalance(rich.session);
      expect(dispatcherAfter).toBe(dispatcherBefore); // hold already left the dispatcher's balance; capture doesn't touch it again

      // The platform-fee 20% is a system account with no user-facing balance
      // route (HTTP surface is balance/statement + grants only, per the
      // brief) — verify it arithmetically against the real captured amounts:
      // owner's real gain (earnerShare) + fee must equal the real charge the
      // dispatcher actually paid, and fee must equal the product's own
      // computeFee() on that charge.
      expect(earnerShare + fee).toBe(charge);
      expect(fee).toBe(computeFee(charge));
      expect(charge).toBe(PRICE_PER_UNIT);

      // Pin the split with NUMERIC LITERALS (review Important 1) — computing both
      // sides from computeCharge/computeFee (as above) is a tautology that can't
      // catch a regression in the pricing functions themselves. These literals are
      // the product's ADVERTISED 80/20 contract for PRICE_PER_UNIT=100, PRICE_UNITS=1:
      // if the split ever changes intentionally, this test MUST be updated consciously.
      expect(charge).toBe(100);
      expect(fee).toBe(20);
      expect(earnerShare).toBe(80);
      expect(PLATFORM_FEE_BPS).toBe(2000);

      const ownerEntries = await getStatement(owner.session, 5);
      expect(ownerEntries[0].reason).toBe("capture");
      expect(ownerEntries[0].amount).toBe(earnerShare);

      // Observe the platform-fee leg + ledger closure directly (review Important 2):
      // the fee account has no HTTP balance route, so this is the only way to see
      // the +20 leg land on the platform system account with reason 'fee', and to
      // confirm every leg tied to this dispatch (hold + capture legs share the same
      // ref_type/ref_id, propagated from hold through settle) nets to exactly zero.
      const { rows: settlementRows } = await dbPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM plugin_shared_agents.settlements WHERE job_id = $1`, [happyJobId]);
      expect(settlementRows.length).toBe(1);
      expect(settlementRows[0].status).toBe("settled");
      const settlementId = settlementRows[0].id;

      const { rows: ledgerRows } = await dbPool.query<{ amount: string; reason: string; system_key: string | null }>(
        `SELECT e.amount, e.reason, a.system_key
           FROM plugin_credits.ledger_entries e
           JOIN plugin_credits.accounts a ON a.id = e.account_id
          WHERE e.ref_type = 'shared-agent-dispatch' AND e.ref_id = $1`,
        [settlementId]);

      const feeLeg = ledgerRows.find((r) => r.reason === "fee");
      expect(feeLeg).toBeDefined();
      expect(Number(feeLeg!.amount)).toBe(20); // +20 to the platform account
      expect(feeLeg!.system_key).toBe("platform");

      const ledgerSum = ledgerRows.reduce((sum, r) => sum + Number(r.amount), 0);
      expect(ledgerSum).toBe(0); // ledger closure: every leg for this dispatch (hold + capture) nets to zero
    }, 180_000);
  });

  // ── 3. Refund path (artifact gate) ───────────────────────────────────
  describe("3. Refund path: completion with error (no results) releases escrow", () => {
    const PRICE_PER_UNIT = 150;
    const charge = computeCharge(PRICE_PER_UNIT, 1);

    let refundTokenId: number;
    let refundTokenPlain: string;
    let workflowId: number;
    let evalSetId: number;

    beforeAll(async () => {
      const t = await createToken(owner.session, `t13-refund-${stamp}`, BASE_EU);
      refundTokenId = t.id; refundTokenPlain = t.token;
      const tier = await setDispatchTier(owner.session, refundTokenId, "shared", PRICE_PER_UNIT);
      expect(tier.ok).toBe(true);

      workflowId = await createWorkflow(rich.session, `t13-refund-wf-${stamp}`, providerId);
      evalSetId = await createEvalSet(rich.session, `t13-refund-es-${stamp}`);
    });

    it("a failed completion (no results) refunds the dispatcher; owner gains nothing", async () => {
      const ownerBefore = await getBalance(owner.session);
      const dispatcherBefore = await getBalance(rich.session);

      const runRes = await authFetch(rich.session, `${BASE_URL}/api/workflows/${workflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: refundTokenId }),
      });
      expect(runRes.status).toBe(200);
      const { job } = await runRes.json();

      const dispatcherAfterHold = await getBalance(rich.session);
      expect(dispatcherAfterHold).toBe(dispatcherBefore - charge);

      const agent = await registerAgent(refundTokenPlain, `t13-refund-agent-${stamp}`);
      const claim = await claimTargeted(refundTokenPlain, agent.id, agent.leaseId, job.id);
      expect(claim.ok).toBe(true);

      const complete = await completeJob(refundTokenPlain, agent.id, agent.leaseId, job.id, { error: "target agent timed out" });
      expect(complete.ok).toBe(true);

      const dispatcherAfter = await pollUntil(() => getBalance(rich.session), (b) => b === dispatcherBefore, 150_000, 5_000);
      expect(dispatcherAfter).toBe(dispatcherBefore); // fully restored

      const ownerAfter = await getBalance(owner.session);
      expect(ownerAfter).toBe(ownerBefore); // owner gains nothing

      const dispatcherEntries = await getStatement(rich.session, 5);
      expect(dispatcherEntries[0].reason).toBe("release");
      expect(dispatcherEntries[0].amount).toBe(charge);
    }, 180_000);
  });

  // ── 4. Insufficient credits soft-gate ────────────────────────────────
  describe("4. Insufficient credits soft-gate: zero-balance dispatcher gets 402, no hold", () => {
    let gateTokenId: number;

    beforeAll(async () => {
      const t = await createToken(owner.session, `t13-gate402-${stamp}`, BASE_NA);
      gateTokenId = t.id;
      const tier = await setDispatchTier(owner.session, gateTokenId, "shared", 500);
      expect(tier.ok).toBe(true);
    });

    it("targeting the shared token with zero credits returns 402 and never touches the balance", async () => {
      const before = await getBalance(broke.session);
      expect(before).toBe(0);

      const workflowId = await createWorkflow(broke.session, `t13-402-wf-${stamp}`, providerId);
      const evalSetId = await createEvalSet(broke.session, `t13-402-es-${stamp}`);

      const runRes = await authFetch(broke.session, `${BASE_URL}/api/workflows/${workflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: gateTokenId }),
      });
      expect(runRes.status).toBe(402);
      const body = await runRes.json();
      expect(body.error).toBe("insufficient-credits");

      const after = await getBalance(broke.session);
      expect(after).toBe(0); // unchanged — no hold was ever placed
    });
  });

  // ── 5. Session-workflow gate interplay ───────────
  describe("5. Session-workflow gate interplay: consent + attestation gates precede the hold", () => {
    const PRICE_PER_UNIT = 250;
    const charge = computeCharge(PRICE_PER_UNIT, 1);

    let sessionTokenId: number;
    let sessionTokenPlain: string;
    let sessionWorkflowId: number;
    let evalSetId: number;
    const emailSecret = `T13_E_${stamp.toUpperCase()}`;
    const passwordSecret = `T13_P_${stamp.toUpperCase()}`;

    beforeAll(async () => {
      const t = await createToken(owner.session, `t13-session-${stamp}`, BASE_NA);
      sessionTokenId = t.id; sessionTokenPlain = t.token;
      const tier = await setDispatchTier(owner.session, sessionTokenId, "shared", PRICE_PER_UNIT);
      expect(tier.ok).toBe(true);

      // rich owns both the secrets AND the workflow: session scope is keyed
      // to the WORKFLOW OWNER (server/auth-session.ts sessionScopeForWorkflow),
      // so keeping owner==caller avoids cross-user scope mismatches.
      await createSecret(rich.session, emailSecret, "t13-test-user@example.com", { brokerType: "auth-session" });
      await createSecret(rich.session, passwordSecret, "t13-test-password-1", { brokerType: "auth-session" });

      const setupSteps = `- type: platform.setup\n  platform_id: vapi\n  params:\n    email: \${secrets.${emailSecret}}\n    password: \${secrets.${passwordSecret}}`;
      sessionWorkflowId = await createWorkflow(rich.session, `t13-session-wf-${stamp}`, providerId, { framework: "aeval", stepsPrefix: setupSteps });
      evalSetId = await createEvalSet(rich.session, `t13-session-es-${stamp}`);
    });

    it("5a. rejects without credentialConsent (400) — balance unchanged", async () => {
      const before = await getBalance(rich.session);
      const res = await authFetch(rich.session, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: sessionTokenId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("credentialConsent is required to dispatch credential-injected jobs to a shared agent");
      expect(await getBalance(rich.session)).toBe(before); // gate fired BEFORE any hold
    });

    it("5b. rejects with consent but unattested secrets (403) — balance unchanged", async () => {
      const before = await getBalance(rich.session);
      const res = await authFetch(rich.session, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: sessionTokenId, credentialConsent: true }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Shared dispatch requires dedicated test-account credentials (mark the login secrets as test accounts)");
      expect(await getBalance(rich.session)).toBe(before);
    });

    it("5c. attested + consent: dispatch proceeds, hold placed, sessionInjection stamped", async () => {
      await createSecret(rich.session, emailSecret, "t13-test-user@example.com", { isTestAccount: true });
      await createSecret(rich.session, passwordSecret, "t13-test-password-1", { isTestAccount: true });

      const before = await getBalance(rich.session);
      const res = await authFetch(rich.session, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: sessionTokenId, credentialConsent: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job.config.sessionInjection).toEqual({ platformId: "vapi" });

      const afterHold = await getBalance(rich.session);
      expect(afterHold).toBe(before - charge); // the money-ordering property: gates ran first, hold ran only once they passed

      // Cleanup: release the hold via a normal failed-completion so no escrow
      // is left dangling for the leak-reaper. Requires the agent to declare
      // the sessionInjection capability to be handed the job at all.
      const agent = await registerAgent(sessionTokenPlain, `t13-session-agent-${stamp}`, { sessionInjection: "1" });
      const job = await findJob(sessionTokenPlain, body.job.id);
      expect(job).toBeDefined();
      const claim = await claimTargeted(sessionTokenPlain, agent.id, agent.leaseId, body.job.id);
      expect(claim.ok).toBe(true);
      const complete = await completeJob(sessionTokenPlain, agent.id, agent.leaseId, body.job.id, { error: "cleanup: no real session runner in this test" });
      expect(complete.ok).toBe(true);

      const restored = await pollUntil(() => getBalance(rich.session), (b) => b === before, 150_000, 5_000);
      expect(restored).toBe(before);
    }, 180_000);
  });

  // ── 6. Free tiers never touch credits ────────────────────────────────
  describe("6. Free tiers (private pooled + private targeted) never touch credits", () => {
    let freeTokenId: number;
    let freeTokenPlain: string;
    beforeAll(async () => {
      const t = await createToken(broke.session, `t13-free-${stamp}`, BASE_NA);
      freeTokenId = t.id; freeTokenPlain = t.token;
    });

    it("6a. free-tier untargeted (pooled) run completes with a zero-credits dispatcher — no 402, no movement", async () => {
      const before = await getBalance(broke.session);
      expect(before).toBe(0);

      // Register the agent BEFORE creating the job so the claim attempt below is
      // immediate. This is an UNTARGETED job in a shared region: any other live
      // agent/daemon polling that same region (e.g. a real dev-local-run.sh daemon,
      // or another suite's agent) can legitimately grab it first, which surfaces as
      // a 409 here — a benign race, not a product bug. Mitigate pragmatically by
      // recreating the job and retrying (up to 2 extra attempts) rather than faking
      // the claim.
      //
      // Dispatched at "private" tier, not "public": public dispatchTier is
      // admin-only (server/dispatch.ts validateTierChoice), and `broke` is a
      // non-admin premium user, so freeTokenPlain is created private by
      // default. The pooled private-tier claim branch matches on the job's
      // creator, which is what makes this an "own agent, untargeted region
      // pool" path — distinct from 6b's explicitly-targeted dispatch below.
      const agent = await registerAgent(freeTokenPlain, `t13-free-agent-${stamp}`);

      let job: { id: number } | undefined;
      let claim: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const workflowId = await createWorkflow(broke.session, `t13-free-wf-${stamp}-${attempt}`, providerId);
        const evalSetId = await createEvalSet(broke.session, `t13-free-es-${stamp}-${attempt}`);
        const runRes = await authFetch(broke.session, `${BASE_URL}/api/workflows/${workflowId}/run`, {
          method: "POST", body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
        });
        expect(runRes.status).toBe(200);
        ({ job } = await runRes.json());

        claim = await claimTargeted(freeTokenPlain, agent.id, agent.leaseId, job!.id);
        if (claim.status !== 409) break;
      }
      expect(claim!.ok).toBe(true);

      const complete = await completeJob(freeTokenPlain, agent.id, agent.leaseId, job!.id, { results: SAMPLE_RESULTS });
      expect(complete.ok).toBe(true);

      expect(await getBalance(broke.session)).toBe(0);
    });

    it("6b. private-tier targeted dispatch (self) completes with a zero-credits dispatcher — no 402, no movement", async () => {
      const tier = await setDispatchTier(broke.session, freeTokenId, "private");
      expect(tier.ok).toBe(true);

      const before = await getBalance(broke.session);
      expect(before).toBe(0);

      const workflowId = await createWorkflow(broke.session, `t13-free2-wf-${stamp}`, providerId);
      const evalSetId = await createEvalSet(broke.session, `t13-free2-es-${stamp}`);

      const runRes = await authFetch(broke.session, `${BASE_URL}/api/workflows/${workflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId, targetTokenId: freeTokenId }),
      });
      expect(runRes.status).toBe(200);
      const { job } = await runRes.json();
      expect(job.targetTokenId).toBe(freeTokenId);

      const agent = await registerAgent(freeTokenPlain, `t13-free2-agent-${stamp}`);
      const claim = await claimTargeted(freeTokenPlain, agent.id, agent.leaseId, job.id);
      expect(claim.ok).toBe(true);
      const complete = await completeJob(freeTokenPlain, agent.id, agent.leaseId, job.id, { results: SAMPLE_RESULTS });
      expect(complete.ok).toBe(true);

      expect(await getBalance(broke.session)).toBe(0);
    });
  });

  // ── 7. Hold voided on post-authorize failure ─────────────────────────
  describe("7. Hold voided when job creation fails AFTER the escrow hold", () => {
    let holdVoidTokenId: number;
    let conflictWorkflowId: number;
    let conflictEvalSetId: number;

    beforeAll(async () => {
      const t = await createToken(owner.session, `t13-holdvoid-${stamp}`, BASE_NA);
      holdVoidTokenId = t.id;
      const tier = await setDispatchTier(owner.session, holdVoidTokenId, "shared", 300);
      expect(tier.ok).toBe(true);

      // Workflow and eval set share the "frameworkVersion" key with
      // CONFLICTING values — neither create-time validator restricts this
      // key, so both creates succeed and the conflict surfaces only inside
      // mergeEvalConfig at run time (server/storage.ts), which is INSIDE the
      // voidDispatch-compensated try (server/routes.ts, Task 6 review fix).
      conflictWorkflowId = await createWorkflow(rich.session, `t13-conflict-wf-${stamp}`, providerId, { framework: "aeval", frameworkVersion: "1.0.0" });
      conflictEvalSetId = await createEvalSet(rich.session, `t13-conflict-es-${stamp}`, { frameworkVersion: "2.0.0" });
    });

    it("shared-tier dispatch with conflicting config: 500, AND the dispatcher's hold is voided (balance restored)", async () => {
      const ownerBefore = await getBalance(owner.session);
      const dispatcherBefore = await getBalance(rich.session);
      const charge = computeCharge(300, 1);

      const runRes = await authFetch(rich.session, `${BASE_URL}/api/workflows/${conflictWorkflowId}/run`, {
        method: "POST", body: JSON.stringify({ evalSetId: conflictEvalSetId, targetTokenId: holdVoidTokenId }),
      });
      expect(runRes.status).toBe(500);
      const body = await runRes.json();
      expect(body.error).toBe("Failed to run workflow");

      // voidDispatch is awaited inside the route's catch block before the 500
      // is returned, so this should already be restored — poll briefly as a
      // safety margin rather than assert instantly.
      const dispatcherAfter = await pollUntil(() => getBalance(rich.session), (b) => b === dispatcherBefore, 30_000, 2_000);
      expect(dispatcherAfter).toBe(dispatcherBefore); // fully restored — no leaked escrow

      const ownerAfter = await getBalance(owner.session);
      expect(ownerAfter).toBe(ownerBefore); // owner never got paid for a job that never existed

      // Review Important 3: an unchanged ENDING balance alone doesn't prove a hold was
      // ever placed — it's also what "never dispatched" looks like. Prove the hold
      // was genuinely placed and then voided by reading the dispatcher's statement
      // (same HTTP surface as scenario 3): the two newest entries for this dispatch
      // must be "release" (the void) immediately followed by "hold" (the escrow), both
      // for exactly `charge`, sharing the same ref (same settlement/dispatch).
      const dispatcherEntries = await getStatement(rich.session, 5);
      expect(dispatcherEntries[0].reason).toBe("release");
      expect(dispatcherEntries[0].amount).toBe(charge); // release credits the dispatcher back +charge
      expect(dispatcherEntries[1].reason).toBe("hold");
      expect(dispatcherEntries[1].amount).toBe(-charge); // the hold itself debited the dispatcher -charge
      expect(dispatcherEntries[0].refId).toBe(dispatcherEntries[1].refId);
      expect(dispatcherEntries[0].refType).toBe("shared-agent-dispatch");
    }, 60_000);
  });
});
