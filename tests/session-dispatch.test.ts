import { describe, it, expect, beforeAll } from "vitest";
import { REGION_NA, BASE_NA } from "./helpers/regions";

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

describe("Phase C: dispatch integration — session stamping, pre-warm, shared-tier gates", () => {
  let admin: AuthSession;
  let providerId: string;
  const stamp = Date.now();

  // Login-class secrets referenced by the "session" workflow's platform.setup.
  const emailSecret = `SD_E_${stamp}`;
  const passwordSecret = `SD_P_${stamp}`;
  // Runtime-class secrets referenced by the "no session" workflow.
  const runtimeEmailSecret = `SD_RE_${stamp}`;
  const runtimePasswordSecret = `SD_RP_${stamp}`;

  let sessionWorkflowId: number;
  let noSessionWorkflowId: number;
  let injectionWorkflowId: number;
  let evalSetId: number;

  beforeAll(async () => {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const providers = await (await fetch(`${BASE_URL}/api/providers`)).json();
    providerId = providers[0].id;

    await createSecret(admin, emailSecret, "sd-test-user@example.com", { secretClass: "login" });
    await createSecret(admin, passwordSecret, "sd-test-password-1", { secretClass: "login" });
    await createSecret(admin, runtimeEmailSecret, "not-a-login@example.com");
    await createSecret(admin, runtimePasswordSecret, "not-a-login-password");

    const setupSteps = (email: string, password: string) =>
      `- type: platform.setup\n  platform_id: vapi\n  params:\n    email: \${secrets.${email}}\n    password: \${secrets.${password}}`;

    const wfRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `Session WF ${stamp}`,
        providerId,
        config: { framework: "aeval", stepsPrefix: setupSteps(emailSecret, passwordSecret) },
      }),
    });
    expect(wfRes.ok).toBe(true);
    sessionWorkflowId = (await wfRes.json()).id;

    const wfNoSessionRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `No-Session WF ${stamp}`,
        providerId,
        config: { framework: "aeval", stepsPrefix: setupSteps(runtimeEmailSecret, runtimePasswordSecret) },
      }),
    });
    expect(wfNoSessionRes.ok).toBe(true);
    noSessionWorkflowId = (await wfNoSessionRes.json()).id;

    const wfInjectionRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `Injection WF ${stamp}`,
        providerId,
        config: {
          framework: "aeval",
          stepsPrefix: setupSteps(emailSecret, passwordSecret),
          sessionInjection: { platformId: "evil" },
        },
      }),
    });
    expect(wfInjectionRes.ok).toBe(true);
    injectionWorkflowId = (await wfInjectionRes.json()).id;

    const esRes = await authFetch(admin, `${BASE_URL}/api/eval-sets`, {
      method: "POST",
      body: JSON.stringify({ name: `Session ES ${stamp}`, config: {} }),
    });
    expect(esRes.ok).toBe(true);
    evalSetId = (await esRes.json()).id;
  });

  it("1. stamps config.sessionInjection when the workflow's platform.setup references login secrets", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: REGION_NA, evalSetId }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.job.config.sessionInjection).toEqual({ platformId: "vapi" });
  });

  it("2. leaves config.sessionInjection undefined when referenced secrets are runtime-class", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: REGION_NA, evalSetId }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.job.config.sessionInjection).toBeUndefined();
  });

  it("3. strips a user-supplied sessionInjection and stamps the server value instead", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${injectionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: REGION_NA, evalSetId }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.job.config.sessionInjection).toEqual({ platformId: "vapi" });
  });

  describe("4-5. shared-tier dispatch: consent + attestation gates", () => {
    let sharedTokenId: number;

    beforeAll(async () => {
      const tRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: `shared-agent-${stamp}`, regionLocationBaseId: BASE_NA, visibility: "public" }),
      });
      expect(tRes.ok).toBe(true);
      sharedTokenId = (await tRes.json()).id;

      const patchRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens/${sharedTokenId}`, {
        method: "PATCH",
        body: JSON.stringify({ dispatchTier: "shared", pricePerUnit: 100 }),
      });
      // If the marketplace plugin isn't loaded in this dev server, this token
      // can never become "shared" and cases 4/5 below are structurally inert
      // (they'll degrade to the "not available" 400, which case 5 also accepts).
      // Fail loudly here so the gap is obvious rather than silently no-op-ing.
      expect(patchRes.ok).toBe(true);
    });

    it("4a. rejects targeted dispatch to a shared agent without credentialConsent", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: sharedTokenId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("credentialConsent is required to dispatch credential-injected jobs to a shared agent");
    });

    it("4b. rejects targeted dispatch when login secrets are not attested as test accounts", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: sharedTokenId, credentialConsent: true }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Shared dispatch requires dedicated test-account credentials (mark the login secrets as test accounts)");
    });

    it("5. passes the gates once secrets are attested and consent is given", async () => {
      await createSecret(admin, emailSecret, "sd-test-user@example.com", { isTestAccount: true });
      await createSecret(admin, passwordSecret, "sd-test-password-1", { isTestAccount: true });

      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: sharedTokenId, credentialConsent: true }),
      });
      const body = await res.json();
      // The consent + attestation gates no longer block. What happens next depends
      // on the marketplace's own decision (credit balance, listing state), which is
      // out of scope here: 200 (authorized), 402 (e.g. insufficient credits), or a
      // 400 "not available" (no marketplace plugin loaded) all prove the point.
      const gatesPassed =
        res.status === 200 ||
        res.status === 402 ||
        (res.status === 400 && body.error === "Shared dispatch is not available");
      expect(gatesPassed).toBe(true);
      if (res.status === 200) {
        expect(body.job.config.sessionInjection).toEqual({ platformId: "vapi" });
        expect(body.job.snapshot.credentialConsent).toBe(true);
      }
    });
  });
});
