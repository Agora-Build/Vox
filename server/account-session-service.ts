import type { PoolClient } from "pg";
import { z } from "zod";
import type { JobSnapshot } from "@shared/schema";
import { accountProvider, accountSetupForJob, acceptsProviderAccountState, type AccountSetup } from "@shared/account-session-setup";
import { ACCOUNT_STATE_FORMAT, ACCOUNT_CHECKPOINT_LIMITS, engineSessionIdSchema } from "@shared/account-session-protocol";
import { pool, encryptValue, decryptValue } from "./storage";
import { getOrganizations } from "./organizations";
import { credentialAgentViolation, ownsCredentialScope } from "./credential-policy";
import { isSessionServable } from "./permissions";
import { AccountSessionError, accountSessionBinding, type AccountSessionScope, type AccountSessionSource } from "./account-session-binding";
import { AccountSessionStore, type AuthorizeAccountSession, type AccountSessionTicket } from "./account-session-store";

export const accountSessionStore = new AccountSessionStore(pool, {
  maxStateBytes: ACCOUNT_CHECKPOINT_LIMITS.snapshotBytes, maxCheckpointsPerRefresh: ACCOUNT_CHECKPOINT_LIMITS.readyRecords,
  acceptsState: (binding, format, state) => format === ACCOUNT_STATE_FORMAT && acceptsProviderAccountState(binding.platformId, state),
});

let retentionRunning: Promise<void> | null = null;
export function runAccountSessionRetention(): Promise<void> {
  if (!retentionRunning) retentionRunning = accountSessionStore.pruneExpired().then(() => undefined,
    () => { console.warn("[Account sessions] Retention sweep failed; will retry"); })
    .finally(() => { retentionRunning = null; });
  return retentionRunning;
}

const baseGrant = z.object({
  version: z.literal(1), sessionId: engineSessionIdSchema, bindingKey: z.string().regex(/^[a-f0-9]{64}$/),
  deadline: z.string().datetime(),
});
const runtimeGrant = baseGrant.extend({
  kind: z.literal("runtime"), jobId: z.number().int().positive(), tokenHash: z.string(),
  leaseId: z.string().min(1), startedAt: z.string().datetime(),
}).strict();
const brokerGrant = baseGrant.extend({
  kind: z.literal("brokered"), mintId: z.number().int().positive(), mintStartedAt: z.string().datetime(),
  brokerId: z.number().int().positive(), brokerLease: z.string().min(1), operationId: z.string().uuid(),
  scope: z.union([z.object({ userId: z.number().int().positive() }).strict(), z.object({ organizationId: z.number().int().positive() }).strict()]),
  need: z.object({ platformId: z.string(), emailSecret: z.string(), passwordSecret: z.string() }).strict(),
}).strict();
const contextSchema = z.discriminatedUnion("kind", [runtimeGrant, brokerGrant]);
export type AccountSessionContext = z.infer<typeof contextSchema>;
const ticketSchema = z.object({ sessionKey: z.string(), generation: z.number().int().positive(),
  executionKey: z.string(), expiresAt: z.string().datetime() }).strict();
const grantSchema = z.object({ context: contextSchema, ticket: ticketSchema.nullable() }).strict();

export function encodeAccountSessionGrant(context: AccountSessionContext, ticket: AccountSessionTicket | null): string {
  return encryptValue(JSON.stringify({ context, ticket: ticket ? { ...ticket, expiresAt: ticket.expiresAt.toISOString() } : null }));
}

export function decodeAccountSessionGrant(value: unknown) {
  try {
    if (typeof value !== "string" || value.length > 16_384) throw new Error();
    const parsed = grantSchema.parse(JSON.parse(decryptValue(value)));
    return { context: parsed.context, ticket: parsed.ticket ? { ...parsed.ticket, expiresAt: new Date(parsed.ticket.expiresAt) } : null };
  } catch { throw new AccountSessionError("unauthorized"); }
}

// The organizations provider takes these same transaction locks on secret and
// membership mutations. Reads still use its seam; no plugin table is read here.
async function lockMemberships(client: PoolClient, ids: number[]) {
  for (const id of Array.from(new Set(ids)).sort((a, b) => a - b)) {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [`account-session:member:${id}`]);
  }
}

function accountOrganizationsReader(client: PoolClient) {
  const provider = getOrganizations();
  if (!provider) return null;
  if (provider.accountSessionFencing !== "postgres-advisory-v1" || !provider.accountSessionReader) {
    throw new AccountSessionError("unauthorized");
  }
  return provider.accountSessionReader({
    async query<T>(sql: string, params?: unknown[]) {
      return { rows: (await client.query(sql, params)).rows as T[] };
    },
  });
}

export async function accountBindingForScope(client: PoolClient, scope: AccountSessionScope, source: AccountSessionSource,
  need: AccountSetup, deliveredCredentials?: Record<string, string>) {
  const profile = accountProvider(need.platformId);
  if (!profile) throw new AccountSessionError("invalid-binding");
  let rows;
  if ("userId" in scope) {
    const enabled = await client.query("SELECT id FROM users WHERE id=$1 AND is_enabled FOR SHARE", [scope.userId]);
    if (!enabled.rowCount) throw new AccountSessionError("unauthorized");
    const result = await client.query(`SELECT id, user_id AS "userId", name, encrypted_value AS "encryptedValue", broker_type AS "brokerType"
      FROM secrets WHERE user_id = $1 AND name = ANY($2) ORDER BY id FOR SHARE`, [scope.userId, [need.emailSecret, need.passwordSecret]]);
    rows = result.rows;
  } else {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [`account-session:org:${scope.organizationId}`]);
    const orgs = accountOrganizationsReader(client);
    if (!orgs) throw new AccountSessionError("unauthorized");
    rows = await orgs.listOrgSecrets(scope.organizationId);
  }
  const email = rows.find(r => r.name === need.emailSecret), password = rows.find(r => r.name === need.passwordSecret);
  if (!email || !password) throw new AccountSessionError("unauthorized");
  const binding = accountSessionBinding({ scope, source, platformId: need.platformId, tenantBinding: profile.tenant, email, password });
  if (deliveredCredentials) {
    deliveredCredentials[email.name] = decryptValue(email.encryptedValue);
    deliveredCredentials[password.name] = decryptValue(password.encryptedValue);
  }
  return binding;
}

export interface RuntimeSessionRequest { jobId: number; tokenHash: string; leaseId: string; startedAt: string; sessionId: string; deadline: string }

export function runtimeAccountAuthority(input: RuntimeSessionRequest, expectedKey?: string, source: AccountSessionSource = "runtime",
  deliveredCredentials?: Record<string, string>): AuthorizeAccountSession {
  return async client => {
    const { rows } = await client.query(`SELECT j.id, j.config, j.snapshot, j.created_by, j.started_at AT TIME ZONE 'UTC' AS started_at, j.target_tier, j.target_token_id,
      a.id AS agent_id, t.id AS token_id, t.created_by AS token_owner, t.dispatch_tier
      FROM eval_jobs j JOIN eval_agents a ON a.id = j.eval_agent_id JOIN eval_agent_tokens t ON t.id = a.token_id
      WHERE j.id = $1 AND j.status = 'running' AND t.token_hash = $2 AND NOT t.is_revoked
        AND a.current_lease_id = $3 AND a.last_seen_at > clock_timestamp() - interval '5 minutes'
      FOR SHARE OF j, a, t`, [input.jobId, input.tokenHash, input.leaseId]);
    const job = rows[0];
    if (!job || !job.started_at || new Date(job.started_at).getTime() !== new Date(input.startedAt).getTime()) return null;
    const snap = job.snapshot as JobSnapshot | null, frozenFlow = snap?.evalFlow;
    if (!frozenFlow || !job.created_by || (source === "runtime" ? !!snap?.sessionInjection : !snap?.sessionInjection)) return null;
    const need = source === "runtime" ? accountSetupForJob(job.config) : snap!.sessionInjection;
    if (!need) return null;
    const userIds = [job.created_by, job.token_owner, frozenFlow.ownerId];
    await lockMemberships(client, userIds);
    const enabled = await client.query("SELECT id FROM users WHERE id = ANY($1) AND is_enabled ORDER BY id FOR SHARE", [userIds]);
    if (enabled.rows.length !== new Set(userIds).size) return null;
    const orgs = frozenFlow.organizationId != null || job.dispatch_tier === "team" ? accountOrganizationsReader(client) : null;
    const callerMembership = frozenFlow.organizationId != null ? await orgs?.getMembership(job.created_by) : null;
    const agentMembership = await orgs?.getMembership(job.token_owner);
    if (credentialAgentViolation(frozenFlow, { createdBy: job.token_owner, dispatchTier: job.dispatch_tier,
      organizationId: agentMembership?.organizationId ?? null }, source === "runtime")) return null;
    if (source === "brokered" && !isSessionServable({ targetTokenId: job.target_token_id,
      evalFlowOwnerId: frozenFlow.ownerId, evalFlowOrgId: frozenFlow.organizationId, consent: snap?.credentialConsent === true },
    { id: job.token_id, createdBy: job.token_owner, dispatchTier: job.dispatch_tier },
    { organizationId: agentMembership?.organizationId ?? null })) return null;
    if (!ownsCredentialScope(frozenFlow, { id: job.created_by, organizationId: callerMembership?.organizationId ?? null })) {
      const trial = snap?.credentialTrial;
      const scopeKey = frozenFlow.organizationId != null ? `org:${frozenFlow.organizationId}` : `user:${frozenFlow.ownerId}`;
      if (!trial || trial.callerId !== job.created_by || trial.scopeKey !== scopeKey || job.target_tier !== "public") return null;
      const permitted = await client.query(`SELECT u.id FROM credential_trial_usage u JOIN credential_trial_policies p ON p.scope_key = u.scope_key
        WHERE u.job_id = $1 AND u.caller_id = $2 AND u.scope_key = $3 AND p.enabled AND p.max_runs_30_days > 0 FOR SHARE OF u, p`,
      [job.id, job.created_by, scopeKey]);
      if (!permitted.rowCount) return null;
    }
    const scope = frozenFlow.organizationId != null ? { organizationId: frozenFlow.organizationId } : { userId: frozenFlow.ownerId };
    const binding = await accountBindingForScope(client, scope, source, need, deliveredCredentials);
    if (expectedKey && binding.sessionKey !== expectedKey) return null;
    return { binding, executionKey: `job:${job.id}:${job.agent_id}:${input.leaseId}:${input.startedAt}:${input.sessionId}`,
      validUntil: new Date(input.deadline) };
  };
}

export function brokerAccountAuthority(context: Extract<AccountSessionContext, { kind: "brokered" }>): AuthorizeAccountSession {
  return async client => {
    const { rows } = await client.query(`SELECT w.id FROM web_sessions w JOIN brokers b ON b.id = w.mint_broker_id
      JOIN broker_registration_tokens t ON t.id = b.token_id
      WHERE w.id = $1 AND w.status = 'minting' AND w.mint_started_at = $2 AND w.mint_operation_id = $3
        AND w.mint_deadline_at > clock_timestamp() AND b.id = $4 AND b.current_lease_id = $5
        AND b.broker_type = 'auth-session' AND b.last_seen_at > clock_timestamp() - interval '5 minutes'
        AND NOT t.is_revoked AND (t.expires_at IS NULL OR t.expires_at > clock_timestamp())
        AND w.account_session_key = $6
      FOR SHARE OF w, b, t`, [context.mintId, context.mintStartedAt, context.operationId, context.brokerId,
      context.brokerLease, context.bindingKey]);
    if (!rows.length) return null;
    const binding = await accountBindingForScope(client, context.scope, "brokered", context.need);
    if (binding.sessionKey !== context.bindingKey) return null;
    return { binding, executionKey: `mint:${context.mintId}:${context.operationId}:${context.sessionId}`, validUntil: new Date(context.deadline) };
  };
}

export function authorityForAccountGrant(context: AccountSessionContext) {
  return context.kind === "runtime" ? runtimeAccountAuthority(context, context.bindingKey) : brokerAccountAuthority(context);
}

/** Return the Runtime pair and its non-secret revision from the same locked rows. */
export async function runtimeAccountCredentialDelivery(input: Omit<RuntimeSessionRequest, "sessionId" | "deadline">) {
  const client = await pool.connect(), credentials: Record<string, string> = {};
  try {
    await client.query("BEGIN");
    const authority = await runtimeAccountAuthority({ ...input, sessionId: "credential-delivery",
      deadline: new Date(Date.now() + 10_000).toISOString() }, undefined, "runtime", credentials)(client);
    await client.query("COMMIT");
    return authority ? { credentials, credentialRevision: authority.binding.sessionKey } : null;
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* Disconnected client. */ } throw error; }
  finally { client.release(); }
}

export async function prepareRuntimeAccountSession(input: Omit<RuntimeSessionRequest, "deadline"> & { credentialRevision: string }) {
  engineSessionIdSchema.parse(input.sessionId);
  const { credentialRevision, ...identity } = input;
  // This deadline never refreshes on checkpoint delivery or retries.
  const request = { ...identity, deadline: new Date(Date.now() + 30 * 60_000).toISOString() };
  const authorize = runtimeAccountAuthority(request, credentialRevision);
  const prior = await accountSessionStore.read(authorize);
  const ticket = await accountSessionStore.claim(authorize, 1800);
  if (!ticket) return { status: "busy" as const, state: prior?.state ?? null };
  const context: AccountSessionContext = { ...request, kind: "runtime", version: 1, bindingKey: ticket.sessionKey };
  return { status: "ready" as const, state: prior?.state ?? null, grant: encodeAccountSessionGrant(context, ticket) };
}

export async function brokerAccountBinding(scope: AccountSessionScope, need: AccountSetup) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const binding = await accountBindingForScope(client, scope, "brokered", need);
    await client.query("COMMIT");
    return binding;
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ } throw error; }
  finally { client.release(); }
}
