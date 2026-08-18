import { describe, it, expect } from "vitest";
import { storage, encryptValue } from "../server/storage";
import { db } from "../server/storage";
import { secrets, workflows, projects } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("login-class secrets are withheld from the job path", () => {
  it("getSecretsForJob returns runtime rows only; login rows never leave Core", async () => {
    const stamp = Date.now();
    // Personal workflow owned by admin (user 1).
    const project = await storage.createProject({ name: `sc-proj-${stamp}`, ownerId: 1 } as any);
    const wf = await storage.createWorkflow({
      name: `sc-wf-${stamp}`, ownerId: 1, projectId: project.id,
      providerId: "bEh-JgzyScxF", visibility: "private", isMainline: false, config: {},
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
  });
});
