import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, encryptValue, db } from "../server/storage";
import { evalJobs, webSessions } from "../shared/schema";
import { eq } from "drizzle-orm";
import { BASE_NA } from "./helpers/regions";

// Task 7: GET /api/eval-agent/jobs/:jobId/session — lease-fenced serve endpoint
// for the Core-minted login session (storageState) behind a claimed job.
//
// Follows the idioms in tests/session-dispatch.test.ts (session-needing
// workflow via platform.setup + login-class secrets) and tests/web-sessions-
// store.test.ts (direct storage manipulation to seed ready/failed rows).

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

interface AuthSession {
  cookie: string;
}

async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie received");
  return { cookie: setCookie.split(";")[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: session.cookie, "Content-Type": "application/json" },
  });
}

async function createSecret(
  session: AuthSession,
  name: string,
  value: string,
  opts?: { secretClass?: "runtime" | "login"; isTestAccount?: boolean },
): Promise<void> {
  const res = await authFetch(session, `${BASE_URL}/api/secrets`, {
    method: "POST",
    body: JSON.stringify({ name, value, ...opts }),
  });
  expect(res.ok).toBe(true);
}

describe("Phase C: GET /api/eval-agent/jobs/:jobId/session", () => {
  let admin: AuthSession;
  let adminId: number;
  let scope: { userId: number } | { organizationId: number };
  let providerId: string;
  const stamp = Date.now();

  // Login-class secrets shared by every session-needing workflow below —
  // evaluateSessionRequirement only cares that the referenced names are
  // login-class in scope, not that each workflow has its own pair.
  const emailSecret = `SE_E_${stamp}`;
  const passwordSecret = `SE_P_${stamp}`;

  const platformIdReady = `vapi-ready-${stamp}`;
  const platformIdFailed = `vapi-failed-${stamp}`;
  const platformIdCold = `vapi-cold-${stamp}`;

  let noSessionWorkflowId: number;
  let readyWorkflowId: number;
  let failedWorkflowId: number;
  let coldWorkflowId: number;
  let pendingGuardWorkflowId: number;
  let supersededWorkflowId: number;
  let evalSetId: number;
  let tokenId: number;
  let tokenValue: string;
  let agentId: number;
  let leaseId: string;

  const seededRowIds: number[] = [];

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const statusRes = await authFetch(admin, `${BASE_URL}/api/auth/status`);
    const statusBody = await statusRes.json();
    adminId = statusBody.user.id;
    // sessionScopeForWorkflow keys off the WORKFLOW's organizationId, not the
    // creating user's own org membership. None of the workflows below pass
    // organizationId on create, so they're personal (organizationId: null)
    // regardless of whether admin happens to belong to an org — scope must
    // match that, not admin's account.
    scope = { userId: adminId };

    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    providerId = providers[0].id;

    await createSecret(admin, emailSecret, "se-test-user@example.com", { secretClass: "login" });
    await createSecret(admin, passwordSecret, "se-test-password-1", { secretClass: "login" });

    const setupSteps = (platformId: string) =>
      `- type: platform.setup\n  platform_id: ${platformId}\n  params:\n    email: \${secrets.${emailSecret}}\n    password: \${secrets.${passwordSecret}}`;

    const mkWorkflow = async (name: string, config: Record<string, unknown>): Promise<number> => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({ name, providerId, config }),
      });
      expect(res.ok).toBe(true);
      return (await res.json()).id as number;
    };

    noSessionWorkflowId = await mkWorkflow(`Session-EP No-Session ${stamp}`, { framework: "aeval" });
    readyWorkflowId = await mkWorkflow(`Session-EP Ready ${stamp}`, { framework: "aeval", stepsPrefix: setupSteps(platformIdReady) });
    failedWorkflowId = await mkWorkflow(`Session-EP Failed ${stamp}`, { framework: "aeval", stepsPrefix: setupSteps(platformIdFailed) });
    coldWorkflowId = await mkWorkflow(`Session-EP Cold ${stamp}`, { framework: "aeval", stepsPrefix: setupSteps(platformIdCold) });
    pendingGuardWorkflowId = await mkWorkflow(`Session-EP Pending ${stamp}`, { framework: "aeval" });
    supersededWorkflowId = await mkWorkflow(`Session-EP Superseded ${stamp}`, { framework: "aeval" });

    const esRes = await authFetch(admin, `${BASE_URL}/api/eval-sets`, {
      method: "POST",
      body: JSON.stringify({ name: `Session-EP ES ${stamp}`, config: {} }),
    });
    expect(esRes.ok).toBe(true);
    evalSetId = (await esRes.json()).id;

    const tRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `session-ep-agent-${stamp}`, regionLocationBaseId: BASE_NA }),
    });
    expect(tRes.ok).toBe(true);
    const tBody = await tRes.json();
    tokenId = tBody.id;
    tokenValue = tBody.token;

    const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: `session-ep-agent-${stamp}`, metadata: {} }),
    });
    expect(regRes.ok).toBe(true);
    const regBody = await regRes.json();
    agentId = regBody.id;
    leaseId = regBody.leaseId;
  });

  afterAll(async () => {
    for (const id of seededRowIds) {
      await db.delete(webSessions).where(eq(webSessions.id, id));
    }
    // Free the login-class secrets so admin's per-user cap (50) isn't exhausted
    // for later suites in the same `npm test` run.
    for (const name of [emailSecret, passwordSecret]) {
      await authFetch(admin, `${BASE_URL}/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    }
  });

  // Dispatches to our own token (default dispatchTier "public" — canDispatchToToken
  // allows it unconditionally) so job.region == token.region == agent.region and
  // the claim below succeeds without needing a specific region constant.
  async function runAndClaim(workflowId: number): Promise<number> {
    const runRes = await authFetch(admin, `${BASE_URL}/api/workflows/${workflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ evalSetId, targetTokenId: tokenId }),
    });
    expect(runRes.ok).toBe(true);
    const jobId = (await runRes.json()).job.id as number;

    const claimRes = await fetch(`${BASE_URL}/api/eval-agent/jobs/${jobId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ agentId, leaseId }),
    });
    expect(claimRes.ok).toBe(true);
    return jobId;
  }

  // /run pre-warms the session cache for session-needing workflows (Task 6:
  // `void ensureSession(scope, sessionNeed)` fired inline, fire-and-forget, right
  // when the job is created). In this dev server SESSION_BROKER_URL/SECRET are
  // unset, so that pre-warm fails fast and lands the row in 'failed' within a
  // handful of local DB round-trips — before our own follow-up assertions run.
  // Wait for it to settle (leave 'minting') before seeding/asserting our own
  // state, so our writes don't race the pre-warm's.
  async function waitForSettled(platformId: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await storage.getWebSession(scope, platformId);
      if (row && row.status !== "minting") return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function sessionGet(jobId: number, lease: string | null = leaseId, bearer: string | null = tokenValue): Promise<Response> {
    const url = `${BASE_URL}/api/eval-agent/jobs/${jobId}/session${lease != null ? `?leaseId=${lease}` : ""}`;
    const headers: Record<string, string> = {};
    if (bearer != null) headers.Authorization = `Bearer ${bearer}`;
    return fetch(url, { headers });
  }

  it("1. running job whose workflow needs no session -> 200 {required:false}", async () => {
    const jobId = await runAndClaim(noSessionWorkflowId);
    const res = await sessionGet(jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ required: false });
  });

  it("2. ready web_session -> 200 with DECRYPTED storageState", async () => {
    const jobId = await runAndClaim(readyWorkflowId);
    await waitForSettled(platformIdReady); // let the /run pre-warm's failed attempt land first

    const row = await storage.claimWebSessionMint(scope, platformIdReady, 180, 300);
    expect(row).toBeDefined();
    seededRowIds.push(row!.id);
    const stored = await storage.storeWebSessionReady(
      row!.id, encryptValue(JSON.stringify({ cookies: [1] })), 12, row!.mintStartedAt!,
    );
    expect(stored).toBe(true);

    const res = await sessionGet(jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.required).toBe(true);
    expect(body.status).toBe("ready");
    expect(body.authMode).toBe("storage");
    expect(body.platformId).toBe(platformIdReady);
    expect(body.storageState).toEqual({ cookies: [1] });
    expect(body.expiresAt).toBeDefined();
  });

  it("3. failed web_session -> 503 with error text", async () => {
    const jobId = await runAndClaim(failedWorkflowId);
    await waitForSettled(platformIdFailed); // let the /run pre-warm's failed attempt land first

    const row = await storage.claimWebSessionMint(scope, platformIdFailed, 180, 300);
    expect(row).toBeDefined();
    seededRowIds.push(row!.id);
    const failed = await storage.markWebSessionFailed(row!.id, "boom", row!.mintStartedAt!);
    expect(failed).toBe(true);

    const res = await sessionGet(jobId);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.required).toBe(true);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("boom");
  });

  it("4. no row at all -> 202 minting, then eventually 503 (no broker configured in this dev server)", async () => {
    const jobId = await runAndClaim(coldWorkflowId);
    // The /run pre-warm already raced ahead and created+failed a row for this
    // platform. Let it settle, then delete it so we can genuinely observe the
    // endpoint's own cold-start (no row at all) path rather than the pre-warm's.
    await waitForSettled(platformIdCold);
    const preWarmRow = await storage.getWebSession(scope, platformIdCold);
    if (preWarmRow) await db.delete(webSessions).where(eq(webSessions.id, preWarmRow.id));

    const res = await sessionGet(jobId);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ required: true, status: "minting" });

    // The endpoint fire-and-forgets ensureSession. Without SESSION_BROKER_URL/
    // SECRET configured, ensureSession's mint attempt throws synchronously
    // inside its try and records the failure on the row — poll briefly for it.
    let last = res;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && last.status !== 503) {
      await new Promise((r) => setTimeout(r, 250));
      last = await sessionGet(jobId);
    }
    expect(last.status).toBe(503);
    const failedBody = await last.json();
    expect(failedBody.status).toBe("failed");

    const row = await storage.getWebSession(scope, platformIdCold);
    if (row) seededRowIds.push(row.id);
  });

  it("5a. no Bearer token -> 401", async () => {
    const jobId = await runAndClaim(noSessionWorkflowId);
    const res = await sessionGet(jobId, leaseId, null);
    expect(res.status).toBe(401);
  });

  it("5b. job still pending (never claimed) -> 403", async () => {
    const runRes = await authFetch(admin, `${BASE_URL}/api/workflows/${pendingGuardWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ evalSetId, targetTokenId: tokenId }),
    });
    expect(runRes.ok).toBe(true);
    const jobId = (await runRes.json()).job.id as number;

    // Not claimed: job.evalAgentId is still null, so this hits
    // authorizeJobAgent's "unauthorized" branch (same guard/order as the
    // adjacent /secrets endpoint) before the endpoint's own running-only
    // check ever runs — a pending job is blocked either way.
    const res = await sessionGet(jobId);
    expect(res.status).toBe(403);
  });

  it("6. serve gate: frozen snapshot owner is a stranger, no consent -> 403 (defense-in-depth)", async () => {
    // The claim + dispatch gates already keep a session job off an
    // unauthorized agent; the serve gate is the credential-authoritative
    // backstop, derived ENTIRELY from the immutable snapshot. Claim a job the
    // normal way (admin owner, admin token), then rewrite its frozen snapshot
    // so the recorded workflow owner is a stranger with no consent — the
    // endpoint must refuse to hand over the bundle even though the LIVE
    // workflow is still admin's.
    const jobId = await runAndClaim(readyWorkflowId);
    const [job] = await db.select().from(evalJobs).where(eq(evalJobs.id, jobId));
    const snap = job.snapshot as Record<string, any>;
    expect(snap?.sessionInjection).toBeDefined(); // sanity: the job really is session-injected
    const mutated = {
      ...snap,
      workflow: { ...snap.workflow, ownerId: adminId + 999999, organizationId: null },
      credentialConsent: false,
    };
    await db.update(evalJobs).set({ snapshot: mutated }).where(eq(evalJobs.id, jobId));

    const res = await sessionGet(jobId);
    expect(res.status).toBe(403);
  });

  it("7. serve gate: session job with NO snapshot stamp -> {required:false}, never mints from live data", async () => {
    // A job whose snapshot carries no sessionInjection must never fall back to
    // deriving the need from the live workflow (HIGH-2). Even though this
    // workflow's live config references login-class secrets, a snapshot with
    // the stamp stripped means the endpoint reports required:false.
    const jobId = await runAndClaim(readyWorkflowId);
    const [job] = await db.select().from(evalJobs).where(eq(evalJobs.id, jobId));
    const snap = job.snapshot as Record<string, any>;
    const { sessionInjection, ...stripped } = snap;
    await db.update(evalJobs).set({ snapshot: stripped }).where(eq(evalJobs.id, jobId));

    const res = await sessionGet(jobId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: false });
  });

  it("5c. wrong leaseId after re-register -> 403 superseded", async () => {
    const jobId = await runAndClaim(supersededWorkflowId);
    // Move the job out of "running" BEFORE re-registering: re-registration
    // releases the agent's currently-running jobs (clearing eval_agent_id),
    // which would make this hit the "unassigned" guard instead of the lease
    // fence we're testing here.
    await db.update(evalJobs).set({ status: "completed" }).where(eq(evalJobs.id, jobId));

    const oldLeaseId = leaseId;
    const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: `session-ep-agent-${stamp}`, metadata: {} }),
    });
    expect(regRes.ok).toBe(true);

    const res = await sessionGet(jobId, oldLeaseId);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.superseded).toBe(true);
  });
});
