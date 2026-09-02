import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BASE_NA } from "./helpers/regions";

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

describe("dispatch integration — session stamping, pre-warm, shared-tier gates", () => {
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

    await createSecret(admin, emailSecret, "sd-test-user@example.com", { brokerType: "auth-session" });
    await createSecret(admin, passwordSecret, "sd-test-password-1", { brokerType: "auth-session" });
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

  // The per-user secret cap (50) is a real product limit; without cleanup these
  // suites accumulate secrets across runs and exhaust admin's budget, breaking
  // unrelated suites later in the same `npm test` invocation. Delete every
  // secret this suite created (SDG_* are added by the "7" block's beforeAll).
  afterAll(async () => {
    for (const name of [
      emailSecret, passwordSecret, runtimeEmailSecret, runtimePasswordSecret,
      `SDG_E_${stamp}`, `SDG_P_${stamp}`, `SDG_SE_${stamp}`, `SDG_SP_${stamp}`,
    ]) {
      await authFetch(admin, `${BASE_URL}/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    }
  });

  it("1. stamps config.sessionInjection when the workflow's platform.setup references login secrets", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${sessionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.job.config.sessionInjection).toEqual({ platformId: "vapi" });
  });

  it("2. leaves config.sessionInjection undefined when referenced secrets are runtime-class", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.job.config.sessionInjection).toBeUndefined();
  });

  it("3. strips a user-supplied sessionInjection and stamps the server value instead", async () => {
    const res = await authFetch(admin, `${BASE_URL}/api/workflows/${injectionWorkflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
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
        // Public tier: still mints WITH a region (zero trust is public-tier-only
        // at mint — region is admin-configured/trusted here). `dispatchTier` is
        // the live field the route reads; `visibility` was a dead legacy name.
        body: JSON.stringify({ name: `shared-agent-${stamp}`, regionLocationBaseId: BASE_NA, dispatchTier: "public" }),
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

  describe("6. escrow-leak fix: jobConfig assembly throws inside the voidDispatch-compensated try", () => {
    let conflictWorkflowId: number;
    let conflictEvalSetId: number;

    beforeAll(async () => {
      // Workflow and eval set share the "frameworkVersion" key with CONFLICTING
      // values. Neither validateWorkflowConfig nor validateEvalSetConfig restricts
      // this key (only "scenario" is eval-set-only and "framework"/"app"/"stepsPrefix"/
      // "stepsSuffix" are workflow-only — see server/storage.ts:~203-258), so both
      // creates succeed and the conflict only surfaces at run time inside
      // mergeEvalConfig (server/storage.ts:~260-280).
      const wfRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: `Conflict WF ${stamp}`,
          providerId,
          config: { framework: "aeval", frameworkVersion: "1.0.0" },
        }),
      });
      expect(wfRes.ok).toBe(true);
      conflictWorkflowId = (await wfRes.json()).id;

      const esRes = await authFetch(admin, `${BASE_URL}/api/eval-sets`, {
        method: "POST",
        body: JSON.stringify({ name: `Conflict ES ${stamp}`, config: { frameworkVersion: "2.0.0" } }),
      });
      expect(esRes.ok).toBe(true);
      conflictEvalSetId = (await esRes.json()).id;
    });

    // This proves only that the throw path lives inside the try (a controlled 500,
    // not a crash / unhandled rejection) for the untargeted (no escrow) path. A full
    // proof that a real escrow hold gets voided when this throw fires mid-shared-
    // dispatch requires live marketplace balances and is deliberately deferred to the
    // practical e2e suite (Task 13).
    it("untargeted run with conflicting shared config keys surfaces a controlled 500, not a crash", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${conflictWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId: conflictEvalSetId }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Failed to run workflow");
    });
  });

  describe("7. credential-injection dispatch guards (owner + team + attested-shared)", () => {
    let stranger: AuthSession;
    let strangerPublicTokenId: number;
    let guardWorkflowId: number; // public, admin-owned, references a login-class pair
    let splitWorkflowId: number; // login-class email + runtime-class password

    // A fresh login-class pair, independent of the 4-5 block's re-attestation of
    // emailSecret/passwordSecret (which rewrites those two secrets mid-suite).
    const gEmail = `SDG_E_${stamp}`;
    const gPass = `SDG_P_${stamp}`;
    // Split-class pair: email is login-class, password is runtime-class.
    const splitEmail = `SDG_SE_${stamp}`;
    const splitPass = `SDG_SP_${stamp}`;

    beforeAll(async () => {
      await createSecret(admin, gEmail, "sdg-test-user@example.com", { brokerType: "auth-session" });
      await createSecret(admin, gPass, "sdg-test-password", { brokerType: "auth-session" });
      await createSecret(admin, splitEmail, "sdg-split-user@example.com", { brokerType: "auth-session" });
      await createSecret(admin, splitPass, "sdg-split-password"); // runtime-class (default)

      const setupSteps = (email: string, password: string) =>
        `- type: platform.setup\n  platform_id: vapi\n  params:\n    email: \${secrets.${email}}\n    password: \${secrets.${password}}`;

      // Default workflow visibility is "public" (server-side), so a stranger can
      // reach the run route's session gate rather than being turned away earlier
      // by canRunWorkflow.
      const gRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: `Guard WF ${stamp}`,
          providerId,
          config: { framework: "aeval", stepsPrefix: setupSteps(gEmail, gPass) },
        }),
      });
      expect(gRes.ok).toBe(true);
      guardWorkflowId = (await gRes.json()).id;

      const sRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: `Split WF ${stamp}`,
          providerId,
          config: { framework: "aeval", stepsPrefix: setupSteps(splitEmail, splitPass) },
        }),
      });
      expect(sRes.ok).toBe(true);
      splitWorkflowId = (await sRes.json()).id;

      // A second, non-owner user (premium so they may own an eval-agent token).
      const inviteRes = await authFetch(admin, `${BASE_URL}/api/admin/invite`, {
        method: "POST",
        body: JSON.stringify({ email: `sdg-stranger-${stamp}@example.com`, plan: "premium" }),
      });
      expect(inviteRes.ok).toBe(true);
      const { token: inviteToken } = await inviteRes.json();

      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `sdg-stranger-${stamp}`, password: "sdg-stranger-pass-123", token: inviteToken }),
      });
      expect(regRes.ok).toBe(true);
      stranger = await login(`sdg-stranger-${stamp}@example.com`, "sdg-stranger-pass-123");

      // Zero trust: region is public-tier-only. `stranger` is non-admin, so
      // dispatchTier defaults to "private" — matching 7b's own comment that
      // post tier-unification a stranger's token is necessarily private/team
      // (public dispatch is admin-only).
      const tRes = await authFetch(stranger, `${BASE_URL}/api/eval-agent-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: `sdg-stranger-token-${stamp}` }),
      });
      expect(tRes.ok).toBe(true);
      strangerPublicTokenId = (await tRes.json()).id;
    });

    it("7a. untargeted stranger run of a PUBLIC credential-injected workflow -> 403", async () => {
      // The workflow is public so canRunWorkflow lets the stranger through; the
      // session gate is what stops them — running it untargeted would let a
      // stranger's own agent pull the OWNER's minted test-account session.
      const res = await authFetch(stranger, `${BASE_URL}/api/workflows/${guardWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(
        "Credential-injected workflows can only be run untargeted by the owner or an org member; dispatch to a shared agent with consent to run it elsewhere",
      );
    });

    it("7b. owner targeting a stranger's token with a session need -> 403", async () => {
      // Post tier-unification, public dispatch is admin-only, so a stranger's
      // token is necessarily private/team — the tier-authorization guard
      // (canDispatchToToken) refuses a stranger-owned token before the session-
      // credential gate is ever reached. Either way a session-injected job never
      // lands on a stranger's agent; here the shallower guard fires first.
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${guardWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: strangerPublicTokenId }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Not allowed to dispatch to this agent");
    });

    it("7c. split-class credential pair (one login, one runtime) -> 400, never a silent runtime leak", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${splitWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        "Login requires BOTH email and password to be dedicated login-class secrets (mark both, or neither)",
      );
    });

    it("7d. owner untargeted public-pool dispatch of a session-injected workflow -> 403", async () => {
      // Even the owner can't pool a credential-injected job into the public
      // tier — a public-pool claim would be admitted by the untargeted-owner
      // check above but then refused the minted session by the serve gate.
      // Reject up front instead. Only private/team pools (or a targeted
      // shared agent with consent) may carry a session-injected job.
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${guardWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "public", evalSetId }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Credential-injected workflows: credential-injected jobs cannot use the public pool");
    });

    it("7e. owner team-pool dispatch of a session-injected PERSONAL (non-org) workflow -> 403", async () => {
      // Distinct from 7d (public-pool rejection): here the dispatcher DOES have
      // an org (so the pre-existing hasOrg "join an organization" 400 does NOT
      // fire — a dispatcher with no org can never reach team tier at all), but
      // the WORKFLOW itself was created with no organizationId (a personal
      // workflow, even though its owner belongs to an org). A team-pool claim
      // would then land on an org-mate's token, and the session serve gate only
      // admits the workflow owner's/org's agents — a personal workflow has
      // none. Without the tightened guard this is a guaranteed-failure dispatch
      // (claims, then 403s fetching the session).
      const inviteRes = await authFetch(admin, `${BASE_URL}/api/admin/invite`, {
        method: "POST",
        body: JSON.stringify({ email: `sdg-orgowner-${stamp}@example.com`, plan: "premium" }),
      });
      expect(inviteRes.ok).toBe(true);
      const { token: orgInviteToken } = await inviteRes.json();
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `sdg-orgowner-${stamp}`, password: "sdg-orgowner-pass-123", token: orgInviteToken }),
      });
      expect(regRes.ok).toBe(true);
      const orgOwner = await login(`sdg-orgowner-${stamp}@example.com`, "sdg-orgowner-pass-123");

      const createOrgRes = await authFetch(orgOwner, `${BASE_URL}/api/organizations`, {
        method: "POST",
        body: JSON.stringify({ name: `SDG Org ${stamp}` }),
      });
      expect(createOrgRes.ok).toBe(true);

      const oEmail = `SDG_OE_${stamp}`;
      const oPass = `SDG_OP_${stamp}`;
      await createSecret(orgOwner, oEmail, "sdg-org-user@example.com", { brokerType: "auth-session" });
      await createSecret(orgOwner, oPass, "sdg-org-password", { brokerType: "auth-session" });

      const wfRes = await authFetch(orgOwner, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: `Org-owner Personal Guard WF ${stamp}`,
          providerId,
          config: {
            framework: "aeval",
            stepsPrefix: `- type: platform.setup\n  platform_id: vapi\n  params:\n    email: \${secrets.${oEmail}}\n    password: \${secrets.${oPass}}`,
          },
          // no organizationId — a PERSONAL workflow despite the owner belonging to an org
        }),
      });
      expect(wfRes.ok).toBe(true);
      const personalWfId = (await wfRes.json()).id;

      const res = await authFetch(orgOwner, `${BASE_URL}/api/workflows/${personalWfId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "team", evalSetId }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Credential-injected workflows: credential-injected jobs can use a team pool only when the workflow belongs to the creator's organization");

      await authFetch(orgOwner, `${BASE_URL}/api/workflows/${personalWfId}`, { method: "DELETE" });
      for (const name of [oEmail, oPass]) {
        await authFetch(orgOwner, `${BASE_URL}/api/secrets/${name}`, { method: "DELETE" });
      }
    });
  });

  describe("8. Brokered-misuse pre-run validation", () => {
    const protectedSecret = `API_TOKEN_${stamp}`;
    let misuseWorkflowId: number;

    beforeAll(async () => {
      await createSecret(admin, protectedSecret, "sdp-protected-value", { brokerType: "auth-session" });

      const misuseRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: `Misuse WF ${stamp}`,
          providerId,
          config: {
            framework: "aeval",
            // References the Brokered secret as a runtime value (an API header),
            // not as a platform.setup email/password login pair.
            stepsPrefix: `- type: http.request\n  params:\n    headers:\n      Authorization: \${secrets.${protectedSecret}}`,
          },
        }),
      });
      expect(misuseRes.ok).toBe(true);
      misuseWorkflowId = (await misuseRes.json()).id;
    });

    afterAll(async () => {
      await authFetch(admin, `${BASE_URL}/api/secrets/${encodeURIComponent(protectedSecret)}`, { method: "DELETE" });
    });

    it("rejects a run when a Brokered secret is used outside platform.setup login", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${misuseWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ region: BASE_NA, targetTier: "private", evalSetId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Brokered secret/i);
      expect(body.error).toContain("API_TOKEN");
    });
  });

  describe("9. runtime-on-shared consent gate", () => {
    let runtimeSharedTokenId: number;

    beforeAll(async () => {
      const tRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens`, {
        method: "POST",
        // Public tier: still mints WITH a region — `dispatchTier` is the live
        // field the route reads; `visibility` was a dead legacy name.
        body: JSON.stringify({ name: `runtime-shared-agent-${stamp}`, regionLocationBaseId: BASE_NA, dispatchTier: "public" }),
      });
      expect(tRes.ok).toBe(true);
      runtimeSharedTokenId = (await tRes.json()).id;

      const patchRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens/${runtimeSharedTokenId}`, {
        method: "PATCH",
        body: JSON.stringify({ dispatchTier: "shared", pricePerUnit: 100 }),
      });
      // Mirrors the "4-5" block's beforeAll: fail loudly if the marketplace plugin
      // isn't loaded rather than letting this degrade into a silent no-op.
      expect(patchRes.ok).toBe(true);
    });

    it("9a. blocks a shared run exposing runtime secrets without consent", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: runtimeSharedTokenId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/runtime secret/i);
      expect(body.error).toContain(runtimeEmailSecret);
    });

    it("9b. allows it with runtimeSecretConsent, recording it on the snapshot when authorized", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run`, {
        method: "POST",
        body: JSON.stringify({ evalSetId, targetTokenId: runtimeSharedTokenId, runtimeSecretConsent: true }),
      });
      const body = await res.json();
      // consent unblocked the runtime gate: it is NOT a 400 whose error is the
      // runtime-exposure message. `marketplace.authorizeDispatch` needs an active
      // listing + credits, so a 200 is not guaranteed in dev (may be 402/400) —
      // mirrors case 5's tolerance for the same reason.
      const gateOpened = !(res.status === 400 && /runtime secret/i.test(body.error ?? ""));
      expect(gateOpened).toBe(true);
      if (res.status === 200) {
        expect(body.job.snapshot.runtimeSecretConsent).toBe(true);
      }
    });
  });

  describe("10. run-targets endpoint", () => {
    let tok: { id: number; siteId: string | null };

    beforeAll(async () => {
      // Must be a non-public tier to show up under "mine" (server/routes.ts
      // explicitly excludes dispatchTier === "public" from that list) — admin's
      // default is public, so this needs an explicit dispatchTier. Zero trust
      // also means non-public tokens never take a region.
      const tRes = await authFetch(admin, `${BASE_URL}/api/eval-agent-tokens`, {
        method: "POST",
        body: JSON.stringify({ name: `rt-own-${stamp}`, dispatchTier: "private" }),
      });
      expect(tRes.ok).toBe(true);
      tok = await tRes.json();
    });

    it("run-targets lists own tokens and referenced-secret classes", async () => {
      const res = await authFetch(admin, `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run-targets?evalSetId=${evalSetId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents.mine.map((a: any) => a.tokenId)).toContain(tok.id);
      expect(body.referencedSecrets).toEqual(
        // `resolvable` was added so the UI can gate on exactly what the server
        // gates on; this secret lives in stepsPrefix, which the daemon resolves.
        expect.arrayContaining([{ name: runtimeEmailSecret, brokerType: null, present: true, resolvable: true }]),
      );
    });
  });

  // note: the shared/marketplace listing path (getMarketplace().listDispatchable)
  // is not exercised here — the marketplace plugin is not seeded in dev, so
  // asserting on `body.agents.shared` would be non-deterministic.
  describe("11. run-targets negative paths", () => {
    let stranger: AuthSession;
    let privateWorkflowId: number;
    let privateEvalSetId: number;
    const isolatedSecret = `RTNEG_ISO_${stamp}`;

    beforeAll(async () => {
      // A non-owner, non-org user with no relationship to admin's resources.
      const inviteRes = await authFetch(admin, `${BASE_URL}/api/admin/invite`, {
        method: "POST",
        body: JSON.stringify({ email: `rtneg-stranger-${stamp}@example.com`, plan: "premium" }),
      });
      expect(inviteRes.ok).toBe(true);
      const { token: inviteToken } = await inviteRes.json();
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `rtneg-stranger-${stamp}`, password: "rtneg-stranger-pass-123", token: inviteToken }),
      });
      expect(regRes.ok).toBe(true);
      stranger = await login(`rtneg-stranger-${stamp}@example.com`, "rtneg-stranger-pass-123");

      // A private workflow owned by admin, for the non-owner-403 case.
      const pRes = await authFetch(admin, `${BASE_URL}/api/workflows`, {
        method: "POST",
        body: JSON.stringify({ name: `RTNeg Private WF ${stamp}`, providerId, visibility: "private", config: { framework: "aeval" } }),
      });
      expect(pRes.ok).toBe(true);
      const privateWorkflow = await pRes.json();
      // Guard against a silent default-to-public, which would make the 403
      // assertion below pass vacuously.
      expect(privateWorkflow.visibility).toBe("private");
      privateWorkflowId = privateWorkflow.id;

      // A unique secret + private eval set (both admin-owned) referencing it,
      // for the cross-tenant secret-exclusion case. `framework` is a
      // workflow-only config key, so the eval set config carries only `scenario`.
      await createSecret(admin, isolatedSecret, "iso-value");
      const esRes = await authFetch(admin, `${BASE_URL}/api/eval-sets`, {
        method: "POST",
        body: JSON.stringify({
          name: `RTNeg Private ES ${stamp}`,
          visibility: "private",
          config: { scenario: `x: \${secrets.${isolatedSecret}}` },
        }),
      });
      expect(esRes.ok).toBe(true);
      const privateEvalSet = await esRes.json();
      expect(privateEvalSet.visibility).toBe("private");
      privateEvalSetId = privateEvalSet.id;
    });

    it("401s when unauthenticated", async () => {
      const res = await fetch(`${BASE_URL}/api/workflows/${noSessionWorkflowId}/run-targets`);
      expect(res.status).toBe(401);
    });

    it("403s when a non-owner targets a private workflow", async () => {
      const res = await authFetch(stranger, `${BASE_URL}/api/workflows/${privateWorkflowId}/run-targets`);
      expect(res.status).toBe(403);
    });

    it("excludes an inaccessible eval set's secret references (cross-tenant isolation)", async () => {
      const res = await authFetch(
        stranger,
        `${BASE_URL}/api/workflows/${noSessionWorkflowId}/run-targets?evalSetId=${privateEvalSetId}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.referencedSecrets.map((s: any) => s.name)).not.toContain(isolatedSecret);
    });
  });
});
