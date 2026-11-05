import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { credentialTrialPolicies, credentialTrialUsage, evalFlows, evalSets, evalJobs, type EvalJob, type InsertEvalJob, type JobSnapshot } from "@shared/schema";
import { trialAllowance, type CredentialTrialPolicy, type FlowTrialLimits } from "@shared/credential-trials";
import { db } from "./storage";
import { getOrganizations } from "./organizations";
import { ownsCredentialScope, type CredentialOwner } from "./credential-policy";

export const credentialScopeKey = (flow: CredentialOwner): string =>
  flow.organizationId != null ? `org:${flow.organizationId}` : `user:${flow.ownerId}`;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function readPolicy(tx: Transaction | typeof db, scopeKey: string): Promise<CredentialTrialPolicy> {
  const [policy] = await tx.select().from(credentialTrialPolicies).where(eq(credentialTrialPolicies.scopeKey, scopeKey));
  return policy ?? { enabled: false, maxRuns30Days: 0 };
}

async function readUsage(tx: Transaction | typeof db, scopeKey: string, callerId: number, flowId: number | null = null) {
  const [usage] = await tx.select({
    caller24Hours: sql<number>`count(*) FILTER (WHERE eval_flow_id = ${flowId} AND caller_id = ${callerId} AND created_at > now() - interval '24 hours')::int`,
    caller30Days: sql<number>`count(*) FILTER (WHERE eval_flow_id = ${flowId} AND caller_id = ${callerId})::int`,
    owner30Days: sql<number>`count(*) FILTER (WHERE scope_key = ${scopeKey})::int`,
  }).from(credentialTrialUsage).where(and(
    or(eq(credentialTrialUsage.scopeKey, scopeKey), flowId == null ? undefined : eq(credentialTrialUsage.evalFlowId, flowId)),
    sql`${credentialTrialUsage.createdAt} > now() - interval '30 days'`,
  ));
  return usage;
}

// Policy writes and admission share the same transaction lock across Core instances.
async function lockScope(tx: Transaction, scopeKey: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credential-trials:${scopeKey}`}, 0))`);
}

export async function getCredentialTrialPolicy(scopeKey: string) {
  const [policy, usage] = await Promise.all([readPolicy(db, scopeKey), readUsage(db, scopeKey, 0)]);
  return { ...policy, used30Days: usage.owner30Days };
}

export async function setCredentialTrialPolicy(scopeKey: string, policy: CredentialTrialPolicy) {
  return db.transaction(async (tx) => {
    await lockScope(tx, scopeKey);
    await tx.insert(credentialTrialPolicies).values({ scopeKey, ...policy }).onConflictDoUpdate({
      target: credentialTrialPolicies.scopeKey, set: { ...policy, updatedAt: new Date() },
    });
  });
}

export async function getCredentialTrialAllowance(flow: CredentialOwner & FlowTrialLimits & { id: number }, callerId: number) {
  const scopeKey = credentialScopeKey(flow);
  return trialAllowance(await readPolicy(db, scopeKey), await readUsage(db, scopeKey, callerId, flow.id), flow);
}

export class CredentialTrialError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Return only this caller's original submission; this never authorizes new work. */
export async function findCredentialTrialJob(
  job: Pick<InsertEvalJob, "createdBy" | "evalFlowId" | "evalSetId" | "targetRegion" | "targetTier" | "targetTokenId">,
  requestKey: string,
  tx: Transaction | typeof db = db,
): Promise<EvalJob | null> {
  if (job.createdBy == null) return null;
  const [existing] = await tx.select({ job: evalJobs }).from(credentialTrialUsage)
    .leftJoin(evalJobs, eq(evalJobs.id, credentialTrialUsage.jobId)).where(and(
      eq(credentialTrialUsage.callerId, job.createdBy), eq(credentialTrialUsage.requestKey, requestKey),
    ));
  if (!existing) return null;
  if (!existing.job || job.targetTier !== "public" || job.targetTokenId != null ||
      existing.job.evalFlowId !== job.evalFlowId || existing.job.evalSetId !== job.evalSetId || existing.job.targetRegion !== job.targetRegion) {
    throw new CredentialTrialError("This submission was already used. Refresh before starting a different trial.", 409);
  }
  return existing.job;
}

/** Admission, accounting and job creation commit together; rejected runs cost no allowance. */
export async function createCredentialTrialJob(job: InsertEvalJob, requestKey: string = randomUUID()): Promise<EvalJob> {
  const snapshot = job.snapshot as JobSnapshot | null;
  const frozenFlow = snapshot?.evalFlow;
  const frozenSet = snapshot?.evalSet;
  if (!frozenFlow || !frozenSet || job.evalSetId == null || job.createdBy == null || job.targetTier !== "public" || job.targetTokenId != null ||
      job.triggerType !== 2 || frozenFlow.visibility !== "public" || job.scheduleId != null) {
    throw new CredentialTrialError("Borrowed credentials require a manual Mainline trial.", 403);
  }
  const scopeKey = credentialScopeKey(frozenFlow);
  return db.transaction(async (tx) => {
    // A retry is the same submission even if the flow has changed owners.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credential-trial-request:${job.createdBy}:${requestKey}`}, 0))`);
    const existing = await findCredentialTrialJob(job, requestKey, tx);
    if (existing) return existing;
    // Per-flow counting survives owner transfers; lock the flow as well as the
    // credential budget so concurrent admissions cannot spend the same slot.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credential-trial-flow:${job.evalFlowId}`}, 0))`);
    await lockScope(tx, scopeKey);
    // A flow becoming private or changing ownership/config while admission waits
    // must not use an obsolete authorization decision.
    const [flow] = await tx.select().from(evalFlows).where(eq(evalFlows.id, job.evalFlowId!)).for("share");
    if (!flow || flow.visibility !== "public" || flow.ownerId !== frozenFlow.ownerId ||
        flow.organizationId !== frozenFlow.organizationId || !isDeepStrictEqual(flow.config, frozenFlow.config)) {
      throw new CredentialTrialError("The flow changed. Refresh before starting a trial.", 409);
    }
    const [evalSet] = await tx.select().from(evalSets).where(eq(evalSets.id, job.evalSetId!)).for("share");
    if (!evalSet || evalSet.ownerId !== frozenSet.ownerId ||
        evalSet.organizationId !== (frozenSet.organizationId ?? null) || evalSet.visibility !== frozenSet.visibility ||
        !isDeepStrictEqual(evalSet.config, frozenSet.config)) {
      throw new CredentialTrialError("The eval set changed. Refresh before starting a trial.", 409);
    }
    const allowance = trialAllowance(await readPolicy(tx, scopeKey), await readUsage(tx, scopeKey, job.createdBy!, flow.id), flow);
    if (!allowance.available) throw new CredentialTrialError(allowance.reason!, 429);
    const [created] = await tx.insert(evalJobs).values({
      ...(job as typeof evalJobs.$inferInsert), transport: snapshot.transport ?? "web",
      snapshot: { ...snapshot, credentialTrial: { scopeKey, callerId: job.createdBy! } },
    }).returning();
    await tx.insert(credentialTrialUsage).values({ scopeKey, callerId: job.createdBy!, evalFlowId: flow.id, jobId: created.id, requestKey });
    return created;
  });
}

/** An agent lease is necessary but not permission to spend another owner's credentials. */
export async function jobMayUseCredentials(job: EvalJob): Promise<boolean> {
  const frozenFlow = job.snapshot?.evalFlow;
  if (!frozenFlow || job.createdBy == null) return false;
  const membership = frozenFlow.organizationId != null
    ? await getOrganizations()?.getMembership(job.createdBy) : null;
  if (ownsCredentialScope(frozenFlow, { id: job.createdBy, organizationId: membership?.organizationId ?? null })) return true;
  const stamp = job.snapshot?.credentialTrial;
  if (!stamp || stamp.callerId !== job.createdBy || stamp.scopeKey !== credentialScopeKey(frozenFlow) || job.targetTier !== "public") return false;
  // Scope opt-out revokes delivery; exhausting a positive cap only stops admission.
  const [usage] = await db.select({ id: credentialTrialUsage.id }).from(credentialTrialUsage)
    .innerJoin(credentialTrialPolicies, eq(credentialTrialPolicies.scopeKey, credentialTrialUsage.scopeKey)).where(and(
      eq(credentialTrialUsage.jobId, job.id), eq(credentialTrialUsage.callerId, job.createdBy), eq(credentialTrialUsage.scopeKey, stamp.scopeKey),
      eq(credentialTrialPolicies.enabled, true), sql`${credentialTrialPolicies.maxRuns30Days} > 0`,
    ));
  return !!usage;
}
