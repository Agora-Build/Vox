import { describe, it, expect } from "vitest";
import { storage, encryptValue } from "../server/storage";
import { db } from "../server/storage";
import { secrets, orgSecrets, users, organizations, evalJobs, providers } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Resolve a real seeded provider id at run time — provider ids are fresh
// nanoids per seed, so hardcoding one breaks on any freshly-reset DB.
async function anyProviderId(): Promise<string> {
  const [p] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!p) throw new Error("no providers seeded");
  return p.id;
}

d("login-class secrets are withheld from the job path", () => {
  it("getSecretsForJob returns runtime rows only; login rows never leave Core", async () => {
    const stamp = Date.now();
    const providerId = await anyProviderId();
    // Personal workflow owned by admin (user 1).
    const project = await storage.createProject({ name: `sc-proj-${stamp}`, ownerId: 1 } as any);
    const wf = await storage.createWorkflow({
      name: `sc-wf-${stamp}`, ownerId: 1, projectId: project.id,
      providerId, visibility: "private", isMainline: false, config: {},
    } as any);
    // One runtime + one login secret for the owner.
    await db.insert(secrets).values({
      userId: 1, name: `SC_RUNTIME_${stamp}`, encryptedValue: encryptValue("ok"), class: "runtime",
    });
    await db.insert(secrets).values({
      userId: 1, name: `SC_LOGIN_${stamp}`, encryptedValue: encryptValue("hunter2"), class: "login",
    });
    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: 1,
      region: "na-us-ashburn-01", config: {},
      snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    const rows = await storage.getSecretsForJob(job.id);
    const names = rows.map(r => r.name);
    expect(names).toContain(`SC_RUNTIME_${stamp}`);
    expect(names).not.toContain(`SC_LOGIN_${stamp}`);

    // Cleanup (delete only our stamped rows/objects).
    await db.delete(secrets).where(eq(secrets.name, `SC_RUNTIME_${stamp}`));
    await db.delete(secrets).where(eq(secrets.name, `SC_LOGIN_${stamp}`));
    // evalJobs.workflowId is ON DELETE SET NULL, so the job row (left in place,
    // matching the repo's existing test pattern) does not block this delete.
    await storage.deleteWorkflow(wf.id);
    await storage.deleteProject(project.id);
  });

  it("getOrgSecretsForJob returns runtime rows only; login rows never leave Core", async () => {
    const stamp = Date.now();
    const providerId = await anyProviderId();
    // Throwaway org + throwaway member user, so we never touch admin user 1.
    const org = await storage.createOrganization({ name: `sc-org-${stamp}` } as any);
    const user = await storage.createUser({
      username: `sc-user-${stamp}`,
      email: `sc-user-${stamp}@test.local`,
      organizationId: org.id,
    } as any);
    // Org-owned workflow: organizationId set, owned by the throwaway member.
    const wf = await storage.createWorkflow({
      name: `sc-org-wf-${stamp}`, ownerId: user.id, organizationId: org.id,
      providerId, visibility: "private", isMainline: false, config: {},
    } as any);
    // One runtime + one login org secret.
    await db.insert(orgSecrets).values({
      organizationId: org.id, name: `SC_ORG_RUNTIME_${stamp}`, encryptedValue: encryptValue("ok"), class: "runtime",
    });
    await db.insert(orgSecrets).values({
      organizationId: org.id, name: `SC_ORG_LOGIN_${stamp}`, encryptedValue: encryptValue("hunter2"), class: "login",
    });
    const job = await storage.createEvalJob({
      workflowId: wf.id, triggerType: 2, evalSetId: null, createdBy: user.id,
      region: "na-us-ashburn-01", config: {},
      snapshot: { provider: null, workflow: null, evalSet: null, creatorPlan: null } as any,
      status: "pending", priority: 0, retryCount: 0, maxRetries: 3,
    } as any);

    const result = await storage.getOrgSecretsForJob(job.id);
    expect(result[`SC_ORG_RUNTIME_${stamp}`]).toBe("ok");
    expect(result).not.toHaveProperty(`SC_ORG_LOGIN_${stamp}`);

    // Cleanup, in FK-safe order: org secrets -> job (frees users.createdBy FK,
    // which has no ON DELETE action) -> workflow (frees users.ownerId /
    // organizations.organizationId FKs) -> user -> org.
    await db.delete(orgSecrets).where(eq(orgSecrets.name, `SC_ORG_RUNTIME_${stamp}`));
    await db.delete(orgSecrets).where(eq(orgSecrets.name, `SC_ORG_LOGIN_${stamp}`));
    await db.delete(evalJobs).where(eq(evalJobs.id, job.id));
    await storage.deleteWorkflow(wf.id);
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(organizations).where(eq(organizations.id, org.id));
  });
});
