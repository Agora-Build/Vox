//
// R3 — the org-credential fence. THIS is the check that stops one organization
// from spending another organization's credentials, so it is pinned directly:
// the fence block that used to live inside the old storage method (a raw
// `creator.organizationId !== workflow.organizationId` comparison on the users
// row) now lives in Core and resolves the creator's membership through the
// `vox.organizations` seam. Every verdict below must match the pre-seam
// behavior exactly — the only thing that changed is where membership comes
// from.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, encryptValue, db } from "../server/storage";
import { orgRuntimeSecretsForJob } from "../server/routes";
import { setOrganizations, resetOrganizations } from "../server/organizations";
import { CoreOrganizations } from "../server/organizations-core";
import { orgSecrets, users, organizations, evalJobs, providers } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const stamp = Date.now();
const RUNTIME = `OF_RUNTIME_${stamp}`;
const LOGIN = `OF_LOGIN_${stamp}`;

async function anyProviderId(): Promise<string> {
  const [p] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!p) throw new Error("no providers seeded");
  return p.id;
}

const mkJob = (workflowId: number, createdBy: number) =>
  storage.createEvalJob({
    workflowId, triggerType: 2, evalSetId: null, createdBy,
    siteId: "na-us-ashburn-01", config: {},
    snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
    status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
  } as any);

d("org-credential fence (R3)", () => {
  let orgA: any, orgB: any, aMember: any, bMember: any, nobody: any, wfA: any;
  let jobByA: any, jobByB: any, jobByNobody: any;

  beforeAll(async () => {
    setOrganizations(new CoreOrganizations(storage));
    const providerId = await anyProviderId();

    orgA = await storage.createOrganization({ name: `of-orgA-${stamp}` } as any);
    orgB = await storage.createOrganization({ name: `of-orgB-${stamp}` } as any);
    aMember = await storage.createUser({
      username: `of-a-${stamp}`, email: `of-a-${stamp}@test.local`, organizationId: orgA.id,
    } as any);
    bMember = await storage.createUser({
      username: `of-b-${stamp}`, email: `of-b-${stamp}@test.local`, organizationId: orgB.id,
    } as any);
    nobody = await storage.createUser({
      username: `of-n-${stamp}`, email: `of-n-${stamp}@test.local`,
    } as any);

    // Org-A-owned workflow. Public, so a non-member CAN legitimately run it —
    // which is exactly the case the fence has to keep credential-free.
    wfA = await storage.createWorkflow({
      name: `of-wf-${stamp}`, ownerId: aMember.id, organizationId: orgA.id,
      providerId, visibility: "public", isMainline: false, config: {},
    } as any);

    // Org-A secrets: one runtime (agent-exposed) + one brokered login row
    // (Core-only — must never reach the runtime map by any path).
    await storage.upsertOrgSecretRow(orgA.id, {
      name: RUNTIME, encryptedValue: encryptValue("runtime-ok"),
      brokerType: null, isTestAccount: false, createdBy: aMember.id,
    });
    await storage.upsertOrgSecretRow(orgA.id, {
      name: LOGIN, encryptedValue: encryptValue("hunter2"),
      brokerType: "agora", isTestAccount: true, createdBy: aMember.id,
    });

    jobByA = await mkJob(wfA.id, aMember.id);
    jobByB = await mkJob(wfA.id, bMember.id);
    jobByNobody = await mkJob(wfA.id, nobody.id);
  });

  afterAll(async () => {
    if (!hasDb) return;
    setOrganizations(new CoreOrganizations(storage));
    for (const j of [jobByA, jobByB, jobByNobody]) {
      if (j) await db.delete(evalJobs).where(eq(evalJobs.id, j.id));
    }
    if (orgA) {
      await db.delete(orgSecrets).where(eq(orgSecrets.organizationId, orgA.id));
    }
    if (wfA) await storage.deleteWorkflow(wfA.id);
    for (const u of [aMember, bMember, nobody]) {
      if (u) await db.delete(users).where(eq(users.id, u.id));
    }
    for (const o of [orgA, orgB]) {
      if (o) await db.delete(organizations).where(eq(organizations.id, o.id));
    }
  });

  it("same-org creator gets the org's runtime secrets", async () => {
    await expect(orgRuntimeSecretsForJob(jobByA.id)).resolves.toHaveProperty(RUNTIME);
  });

  it("CROSS-ORG creator gets {} — one org can never spend another's credentials", async () => {
    await expect(orgRuntimeSecretsForJob(jobByB.id)).resolves.toEqual({});
  });

  it("creator with no membership gets {}", async () => {
    await expect(orgRuntimeSecretsForJob(jobByNobody.id)).resolves.toEqual({});
  });

  it("absent provider gets {} — never a leak, never a write", async () => {
    resetOrganizations();
    // finally, not a trailing statement: if the assertion above ever fails, an
    // unrestored provider would leave the NEXT case (brokered exclusion) passing
    // vacuously — {} has no LOGIN property for the wrong reason.
    try {
      await expect(orgRuntimeSecretsForJob(jobByA.id)).resolves.toEqual({});
    } finally {
      setOrganizations(new CoreOrganizations(storage)); // restore for later cases
    }
  });

  it("brokered (login-class) rows never appear in the runtime map", async () => {
    const m = await orgRuntimeSecretsForJob(jobByA.id);
    expect(m).not.toHaveProperty(LOGIN); // Core-only class, structurally excluded
  });
});
