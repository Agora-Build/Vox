import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BASE_NA } from "./helpers/regions";

// Task 8: GET /api/eval-agent/jobs capability gate — a session-stamped job
// (Task 6: config.sessionInjection = { platformId }) must never be handed to
// a daemon that can't force storage-mode (it would run the login-gated
// target UNAUTHENTICATED). The gate is registration metadata
// `sessionInjection: "1"` (Task 10 sends this from the real daemon).
//
// Follows the idioms in tests/session-dispatch.test.ts (session-needing
// workflow via platform.setup + login-class secrets) and the
// "Version-Gated Job Fetching" describe block in tests/api.test.ts
// (token/agent registration + region-scoped job listing).

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
  opts?: { brokerType?: string | null; isTestAccount?: boolean },
): Promise<void> {
  const res = await authFetch(session, `${BASE_URL}/api/secrets`, {
    method: "POST",
    body: JSON.stringify({ name, value, ...opts }),
  });
  expect(res.ok).toBe(true);
}

describe("GET /api/eval-agent/jobs — session-capability gate", () => {
  let admin: AuthSession;
  let providerId: string;
  const stamp = Date.now();

  const emailSecret = `SCG_E_${stamp}`;
  const passwordSecret = `SCG_P_${stamp}`;

  let sessionWorkflowId: number;
  let plainWorkflowId: number;
  let evalSetId: number;

  let tokenValue: string;
  let region: string;

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    providerId = providers[0].id;

    // Login-class secrets so the "session" workflow's platform.setup is
    // evaluated by evaluateSessionRequirement as a session "need" and its jobs
    // get stamped with config.sessionInjection.
    await createSecret(admin, emailSecret, "scg-test-user@example.com", { brokerType: "auth-session" });
    await createSecret(admin, passwordSecret, "scg-test-password-1", { brokerType: "auth-session" });

    const setupSteps =
      `- type: platform.setup\n  platform_id: vapi\n  params:\n    email: \${secrets.${emailSecret}}\n    password: \${secrets.${passwordSecret}}`;

    const wfRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `SCG Session WF ${stamp}`,
        providerId,
        // Deliberately no frameworkVersion — the version-gate half of the
        // filter must stay neutral so this test isolates the capability check.
        config: { framework: "aeval", stepsPrefix: setupSteps },
      }),
    });
    expect(wfRes.ok).toBe(true);
    sessionWorkflowId = (await wfRes.json()).id;

    const plainWfRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `SCG Plain WF ${stamp}`,
        providerId,
        config: { framework: "aeval" },
      }),
    });
    expect(plainWfRes.ok).toBe(true);
    plainWorkflowId = (await plainWfRes.json()).id;

    const esRes = await authFetch(admin, `${BASE_URL}/api/eval-sets`, {
      method: "POST",
      body: JSON.stringify({ name: `SCG ES ${stamp}`, config: {} }),
    });
    expect(esRes.ok).toBe(true);
    evalSetId = (await esRes.json()).id;

    // Token + region: capture the server-resolved site region rather than
    // assuming one, same idiom as tests/api.test.ts's version-gate suite.
    const tokenRes = await authFetch(admin, `${BASE_URL}/api/admin/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `SCG Token ${stamp}`, regionLocationBaseId: BASE_NA }),
    });
    expect(tokenRes.ok).toBe(true);
    const tokenData = await tokenRes.json();
    tokenValue = tokenData.token;
    region = tokenData.siteId;
  });

  // Release the login-class secrets so admin's per-user cap (50) isn't exhausted
  // for later suites in the same `npm test` run.
  afterAll(async () => {
    for (const name of [emailSecret, passwordSecret]) {
      await authFetch(admin, `${BASE_URL}/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    }
  });

  it("hides a session-stamped job from an agent whose registration lacks the capability, but still lists a plain job", async () => {
    // Register WITHOUT sessionInjection capability metadata.
    const regRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "SCG Incapable Agent" }),
    });
    expect(regRes.ok).toBe(true);

    // Session-stamped job.
    const sessionRunRes = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ siteId: region, evalSetId }),
    });
    expect(sessionRunRes.ok).toBe(true);
    const sessionJob = (await sessionRunRes.json()).job;
    expect(sessionJob.config.sessionInjection).toEqual({ platformId: "vapi" });

    // Plain job (no login secrets referenced — no stamp).
    const plainRunRes = await authFetch(admin, `${BASE_URL}/api/workflows/${plainWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ siteId: region, evalSetId }),
    });
    expect(plainRunRes.ok).toBe(true);
    const plainJob = (await plainRunRes.json()).job;
    expect(plainJob.config.sessionInjection).toBeUndefined();

    const jobsRes = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
      headers: { Authorization: `Bearer ${tokenValue}` },
    });
    expect(jobsRes.ok).toBe(true);
    const jobs: Array<{ id: number }> = await jobsRes.json();
    const ids = jobs.map((j) => j.id);

    expect(ids).toContain(plainJob.id);
    expect(ids).not.toContain(sessionJob.id);

    // Re-register on the SAME token WITH the capability — registrations on
    // one token supersede (latest wins per getEvalAgentsByTokenId(...)[0]).
    const reRegRes = await fetch(`${BASE_URL}/api/eval-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenValue}` },
      body: JSON.stringify({ name: "SCG Incapable Agent", metadata: { sessionInjection: "1" } }),
    });
    expect(reRegRes.ok).toBe(true);

    const jobsRes2 = await fetch(`${BASE_URL}/api/eval-agent/jobs`, {
      headers: { Authorization: `Bearer ${tokenValue}` },
    });
    expect(jobsRes2.ok).toBe(true);
    const jobs2: Array<{ id: number }> = await jobsRes2.json();
    const ids2 = jobs2.map((j) => j.id);

    expect(ids2).toContain(plainJob.id);
    expect(ids2).toContain(sessionJob.id);
  });
});
