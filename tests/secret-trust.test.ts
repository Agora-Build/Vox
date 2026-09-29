import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { BASE_NA } from "./helpers/regions";
import { setOrganizations, resetOrganizations, type OrganizationsProvider, type Membership } from "../server/organizations";
import { evalSetMayUseSecrets, resolvableSecretSources, secretGate } from "../server/auth-session";
import { mergeEvalConfig } from "../server/storage";

// "Only when trusted" (designs/2026-09-29-secret-substitution.md): an eval set
// gets the eval flow's secrets only when its author could already have put the
// same references into the eval flow's Setup — same secret owner, and the eval
// set's owner can edit the eval flow.

const ORG_A = 10;
const ORG_B = 20;
// user → membership
const members: Record<number, Membership | null> = {
  1: { organizationId: ORG_A, role: "member" } as Membership, // flow owner (plain member)
  2: { organizationId: ORG_A, role: "admin" } as Membership,  // org A admin
  3: { organizationId: ORG_A, role: "owner" } as Membership,  // org A owner
  4: { organizationId: ORG_A, role: "member" } as Membership, // plain member
  5: { organizationId: ORG_B, role: "admin" } as Membership,  // another org's admin
  6: null,                                                     // no org
};

const notUsed = async () => { throw new Error("not used by this suite"); };
const provider: OrganizationsProvider = {
  getMembership: async (userId: number) => members[userId] ?? null,
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
  countMembers: async () => 0,
  countOrgAdmins: async () => 0,
  listOrganizations: async () => [],
  createOrganization: notUsed,
  updateOrganization: notUsed,
  setVerified: notUsed,
  addMember: notUsed,
  setMemberRole: notUsed,
  removeMember: notUsed,
  listOrgSecrets: async () => [],
  upsertOrgSecret: notUsed,
  deleteOrgSecret: notUsed,
};

beforeEach(() => { resetOrganizations(); setOrganizations(provider); });
afterAll(() => resetOrganizations());

const personalFlow = { ownerId: 1, organizationId: null };
const orgFlow = { ownerId: 1, organizationId: ORG_A };
const set = (ownerId: number, organizationId: number | null) => ({ ownerId, organizationId });

describe("evalSetMayUseSecrets — every row of the design's table", () => {
  it("personal eval flow: only the owner's own personal eval set", async () => {
    expect(await evalSetMayUseSecrets(personalFlow, set(1, null))).toBe(true);
    expect(await evalSetMayUseSecrets(personalFlow, set(1, ORG_A))).toBe(false); // org-owned, even created by me
    expect(await evalSetMayUseSecrets(personalFlow, set(4, null))).toBe(false); // a colleague's
    expect(await evalSetMayUseSecrets(personalFlow, set(6, null))).toBe(false); // a stranger's
  });

  it("org eval flow: org-owned eval sets created by someone who can edit the flow", async () => {
    expect(await evalSetMayUseSecrets(orgFlow, set(1, ORG_A))).toBe(true);  // the flow's owner
    expect(await evalSetMayUseSecrets(orgFlow, set(2, ORG_A))).toBe(true);  // org admin
    expect(await evalSetMayUseSecrets(orgFlow, set(3, ORG_A))).toBe(true);  // org owner
    expect(await evalSetMayUseSecrets(orgFlow, set(4, ORG_A))).toBe(false); // plain member
  });

  it("org eval flow: never a personal eval set, nor another org's", async () => {
    expect(await evalSetMayUseSecrets(orgFlow, set(1, null))).toBe(false); // flow owner's personal set
    expect(await evalSetMayUseSecrets(orgFlow, set(2, null))).toBe(false);
    expect(await evalSetMayUseSecrets(orgFlow, set(5, ORG_B))).toBe(false);
  });

  it("the creator must still be in the org now: a former admin's org eval set is not trusted", async () => {
    const was = members[2];
    members[2] = null;
    try {
      expect(await evalSetMayUseSecrets(orgFlow, set(2, ORG_A))).toBe(false);
    } finally {
      members[2] = was;
    }
  });

  it("a failing organizations provider throws — it is not an answer", async () => {
    setOrganizations({ ...provider, getMembership: async () => { throw new Error("provider down"); } });
    await expect(evalSetMayUseSecrets(orgFlow, set(2, ORG_A))).rejects.toThrow(/provider down/);
  });

  it("no eval set → nothing to trust", async () => {
    expect(await evalSetMayUseSecrets(personalFlow, undefined)).toBe(false);
  });
});

describe("resolvableSecretSources — the eval set counts only when trusted", () => {
  const flowCfg = { stepsPrefix: "- type: call.dial\n  number: ${secrets.PHONE}\n" };
  const setCfg = { scenario: "steps:\n  - type: log\n    text: ${secrets.SET_KEY}\n" };
  it("includes the eval set's scenario only with evalSetSecrets", () => {
    expect(resolvableSecretSources(flowCfg, setCfg, true)).toContain(setCfg.scenario);
    expect(resolvableSecretSources(flowCfg, setCfg, false)).not.toContain(setCfg.scenario);
    expect(resolvableSecretSources(flowCfg, setCfg, false)).toContain(flowCfg.stepsPrefix);
  });
});

describe("secretGate — untrusted eval set referencing a secret is refused before any job", () => {
  it("names the secrets and says why", async () => {
    const gate = await secretGate(
      { ...personalFlow, config: {} },
      { ...set(6, null), config: { scenario: "steps:\n  - type: log\n    text: ${secrets.OWNER_KEY}\n" } },
    );
    expect(gate.evalSetSecrets).toBe(false);
    expect(gate.error).toMatch(/The eval set uses secret\(s\) OWNER_KEY, but it may not use this eval flow's secrets/);
  });

  it("an untrusted eval set with no secret references is fine — and is not filled", async () => {
    const gate = await secretGate(
      { ...orgFlow, config: {} },
      { ...set(4, ORG_A), config: { scenario: "steps:\n  - type: audio.wait_for_speech\n" } },
    );
    expect(gate).toEqual({ evalSetSecrets: false, error: null });
  });
});

describe("mergeEvalConfig — evalSetSecrets is server-stamped only", () => {
  it("strips whatever either config carries and stamps the server's answer", () => {
    const merged = mergeEvalConfig({ evalSetSecrets: true, stepsPrefix: "x" }, { evalSetSecrets: true, scenario: "y" }, { evalSetSecrets: false });
    expect(merged.evalSetSecrets).toBe(false);
    expect(merged.scenario).toBe("y");
    expect(merged.stepsPrefix).toBe("x");
    expect(mergeEvalConfig({}, { scenario: "y" }, { evalSetSecrets: true }).evalSetSecrets).toBe(true);
  });

  it("differing caller values never trip the conflicting-keys check", () => {
    expect(() => mergeEvalConfig({ evalSetSecrets: true }, { evalSetSecrets: false }, { evalSetSecrets: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Against the running server: the console run route and /api/v1 both refuse
// an untrusted eval set that references a secret, and stamp the answer into
// the job they do create.
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";
const hasDb = !!process.env.DATABASE_URL;

type Session = { cookie: string };
const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];
async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return { cookie: cookieOf(res) };
}
const call = (s: Session, method: string, p: string, body?: unknown) =>
  fetch(`${BASE_URL}${p}`, {
    method, headers: { "Content-Type": "application/json", Cookie: s.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function newUser(admin: Session, tag: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = "TestPass123!";
  const invite = await call(admin, "POST", "/api/admin/invite", { email, plan: "premium" });
  if (!invite.ok) throw new Error(`invite: ${invite.status}`);
  const { token } = await invite.json();
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email.split("@")[0].replace(/[^a-z0-9]/gi, ""), password, token }),
  });
  if (!reg.ok) throw new Error(`register: ${reg.status}`);
  return login(email, password);
}

(hasDb ? describe : describe.skip)("the run routes apply the trust rule", () => {
  const SECRET = `TRUST_T_${Date.now()}`;
  const scenarioUsingSecret = `steps:\n  - type: audio.wait_for_speech\n    description: \${secrets.${SECRET}}\n`;
  let owner: Session;
  let stranger: Session;
  let ownerKey: string;
  let flowId: number;
  let ownSetId: number;
  let strangersSetId: number;
  let strangersPlainSetId: number;

  beforeAll(async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    owner = await newUser(admin, "trust-owner");
    stranger = await newUser(admin, "trust-stranger");
    // /api/v1 runs are owner-only, so the API case is the owner choosing a
    // stranger's eval set for their own flow.
    ownerKey = (await (await call(owner, "POST", "/api/user/api-keys", { name: "trust" })).json()).key;
    const secret = await call(owner, "POST", "/api/secrets", { name: SECRET, value: "s3cret-value" });
    if (!secret.ok) throw new Error(`secret: ${secret.status} ${await secret.text()}`);
    const providerId = (await (await fetch(`${BASE_URL}/api/providers`)).json())[0].id;
    const project = await (await call(owner, "POST", "/api/projects", { name: `trust-${Date.now()}` })).json();
    flowId = (await (await call(owner, "POST", "/api/eval-flows", {
      name: `trust-flow-${Date.now()}`, visibility: "public", projectId: project.id, providerId,
    })).json()).id;
    const mkSet = async (s: Session, scenario: string) =>
      (await (await call(s, "POST", "/api/eval-sets", {
        name: `trust-set-${Date.now()}-${Math.random()}`, visibility: "public", config: { scenario },
      })).json()).id as number;
    ownSetId = await mkSet(owner, scenarioUsingSecret);
    strangersSetId = await mkSet(stranger, scenarioUsingSecret);
    strangersPlainSetId = await mkSet(stranger, "steps:\n  - type: audio.wait_for_speech\n");
  }, 60_000);

  const consoleRun = (s: Session, evalSetId: number) =>
    call(s, "POST", `/api/eval-flows/${flowId}/run`, { evalSetId, region: BASE_NA, targetTier: "public" });
  const apiRun = (key: string, evalSetId: number) =>
    fetch(`${BASE_URL}/api/v1/eval-flows/${flowId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ evalSetId, region: BASE_NA, targetTier: "public" }),
    });

  it("a stranger's eval set that uses the flow owner's secret is refused — whoever runs it, console and API", async () => {
    for (const res of [
      await consoleRun(stranger, strangersSetId),
      await consoleRun(owner, strangersSetId),
      await apiRun(ownerKey, strangersSetId),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(new RegExp(`The eval set uses secret\\(s\\) ${SECRET}, but it may not use`));
    }
  });

  it("the owner's own eval set using the same secret runs, stamped evalSetSecrets: true", async () => {
    const res = await consoleRun(owner, ownSetId);
    expect(res.status).toBe(200);
    expect((await res.json()).job.config.evalSetSecrets).toBe(true);
  });

  it("anyone may run the owner's public eval flow with the owner's public eval set — trusted, whoever runs it", async () => {
    // Trust is about who owns the eval set and the eval flow, not who clicks Run.
    const res = await consoleRun(stranger, ownSetId);
    expect(res.status).toBe(200);
    expect((await res.json()).job.config.evalSetSecrets).toBe(true);
  });

  it("a stranger's eval set without secrets still runs on the flow — stamped evalSetSecrets: false", async () => {
    const res = await consoleRun(stranger, strangersPlainSetId);
    expect(res.status).toBe(200);
    expect((await res.json()).job.config.evalSetSecrets).toBe(false);
    const viaApi = await apiRun(ownerKey, strangersPlainSetId);
    expect(viaApi.status).toBe(201);
    expect((await viaApi.json()).data.job.config.evalSetSecrets).toBe(false);
  });
});
