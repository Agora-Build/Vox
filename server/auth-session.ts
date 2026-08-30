/**
 * auth-session — Core-side login-session logic.
 *
 * Core mints login sessions (Playwright storageState) for web eval targets by
 * driving the auth-session broker (aeval `setup:account` headless login),
 * caches them encrypted in web_sessions, and serves them to agents at claim
 * time. Login-class secrets NEVER leave Core; agents only ever see the
 * storageState. Broker addressing/routing lives in `./broker-registry`.
 */
import { createHash } from "crypto";
import { collectSecretRefs } from "@shared/secrets";
import yaml from "js-yaml";
import { storage, encryptValue, decryptValue, type SessionScope } from "./storage";
import { brokerAvailable, routeToBroker, mintViaBroker, isKnownBrokerType } from "./broker-registry";

export interface PlatformSetupInfo {
  platformId: string;
  emailSecret: string | null;    // ${secrets.NAME} referenced by params.email
  passwordSecret: string | null; // ${secrets.NAME} referenced by params.password
}

const SECRET_REF = /^\$\{secrets\.([A-Za-z0-9_]+)\}$/;

/** Parse the FIRST platform.setup step out of a stepsPrefix/scenario YAML string. */
export function parsePlatformSetup(stepsYaml: string | null | undefined): PlatformSetupInfo | null {
  if (!stepsYaml) return null;
  let steps: unknown;
  try { steps = yaml.load(stepsYaml); } catch { return null; }
  if (!Array.isArray(steps)) {
    // A full scenario document: steps under .steps
    const doc = steps as { steps?: unknown } | null;
    if (doc && Array.isArray((doc as { steps?: unknown }).steps)) steps = (doc as { steps: unknown[] }).steps;
    else return null;
  }
  for (const raw of steps as unknown[]) {
    const step = raw as { type?: string; platform_id?: string; params?: Record<string, unknown> };
    if (step?.type !== "platform.setup" || typeof step.platform_id !== "string") continue;
    const params = (step.params ?? {}) as Record<string, unknown>;
    const ref = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const m = SECRET_REF.exec(v.trim());
      return m ? m[1] : null;
    };
    return { platformId: step.platform_id, emailSecret: ref(params.email), passwordSecret: ref(params.password) };
  }
  return null;
}

/**
 * SINGLE choke-point for org-vs-personal session scoping (mirrors the
 * secrets-follow-workflow-ownership rule). When organizations move to a
 * plugin, the org branch here goes behind that plugin's seam — nothing else
 * in the session path reads workflow.organizationId.
 */
export function sessionScopeForWorkflow(wf: { ownerId: number; organizationId: number | null }): SessionScope {
  return wf.organizationId != null ? { organizationId: wf.organizationId } : { userId: wf.ownerId };
}

export interface SessionNeed { platformId: string; emailSecret: string; passwordSecret: string }

/**
 * Stable identity of the login credential PAIR behind a session need, used as
 * the web_sessions cache key alongside (scope, platformId). Derived from the
 * two login-secret NAMES (not their decrypted values — no secret material, no
 * DB read) so it is cheap and deterministic. Two workflows that reference the
 * same secret pair share a cached session (correct); two accounts on the same
 * platform under one owner get separate rows, so an attested test-account
 * session is never served in place of a different account's (HIGH-2).
 */
export function credentialKeyFor(need: SessionNeed): string {
  return createHash("sha256").update(`${need.emailSecret}\n${need.passwordSecret}`).digest("hex");
}

/**
 * The outcome of deciding whether a workflow needs a Core-minted login session:
 *  - `none`         — runtime path; the agent may fetch its (runtime-class) secrets directly.
 *  - `need`         — Core must mint a storageState; login secrets stay in Core.
 *  - `misconfigured`— a split-class credential pair. REJECT the run rather than
 *    fall back to either path: a "one login-class, one runtime-class" pair would
 *    otherwise leak the runtime-class credential to the agent while Core mints
 *    from the login-class one. Both must be login-class, or neither.
 */
export type SessionRequirement =
  | { kind: "none" }
  | { kind: "need"; need: SessionNeed }
  | { kind: "misconfigured"; reason: string };

export function evaluateSessionRequirement(
  setup: PlatformSetupInfo | null,
  loginSecretNames: Set<string>,
): SessionRequirement {
  if (!setup) return { kind: "none" };
  const emailLogin = !!setup.emailSecret && loginSecretNames.has(setup.emailSecret);
  const passwordLogin = !!setup.passwordSecret && loginSecretNames.has(setup.passwordSecret);
  // Neither credential is login-class → no Core session needed (runtime path).
  if (!emailLogin && !passwordLogin) return { kind: "none" };
  // At least one is login-class: demand BOTH refs present AND both login-class.
  if (!setup.emailSecret || !setup.passwordSecret || !emailLogin || !passwordLogin) {
    return {
      kind: "misconfigured",
      reason: "Login requires BOTH email and password to be dedicated login-class secrets (mark both, or neither)",
    };
  }
  return { kind: "need", need: { platformId: setup.platformId, emailSecret: setup.emailSecret, passwordSecret: setup.passwordSecret } };
}

export async function getBrokeredSecretNames(scope: SessionScope): Promise<Set<string>> {
  if ("userId" in scope) {
    const rows = await storage.getSecretsByUserId(scope.userId);
    return new Set(rows.filter(s => s.brokerType === "auth-session").map(s => s.name));
  }
  const rows = await storage.getOrgSecrets(scope.organizationId);
  return new Set(rows.filter(s => s.brokerType === "auth-session").map(s => s.name));
}

async function resolveScopeSecret(scope: SessionScope, name: string): Promise<string | undefined> {
  if ("userId" in scope) {
    const rows = await storage.getSecretsByUserId(scope.userId);
    const row = rows.find(s => s.name === name);
    return row ? decryptValue(row.encryptedValue) : undefined;
  }
  const rows = await storage.getOrgSecrets(scope.organizationId);
  const row = rows.find(s => s.name === name);
  return row ? decryptValue(row.encryptedValue) : undefined;
}

export const SESSION_FRESH_MARGIN_SECONDS = 300;
export function mintTimeoutSeconds(): number {
  return parseInt(process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS || "180", 10);
}
/**
 * When another instance's 'minting' claim is considered abandoned and may be
 * stolen. This MUST exceed the client-side mint-abort deadline
 * (mintTimeoutSeconds() + 15s, see mintViaBroker's AbortSignal) — otherwise a
 * mint still legitimately in flight gets reclaimed, causing a wasteful
 * double-mint (harmless thanks to the fence, but avoidable). +30s of headroom
 * over the abort keeps the single-flight actually single.
 */
export function staleMintThresholdSeconds(): number {
  return mintTimeoutSeconds() + 30;
}
export function ttlHours(): number {
  return parseInt(process.env.WEB_SESSION_TTL_HOURS || "1", 10);
}

type FetchLike = typeof fetch;

/**
 * Mint-if-needed. Safe to fire-and-forget: single-flight via the DB claim, all
 * failures recorded on the row (status='failed', lastError). Never throws.
 */
export async function ensureSession(
  scope: SessionScope, need: SessionNeed, fetchImpl: FetchLike = fetch,
): Promise<void> {
  try {
    const credentialKey = credentialKeyFor(need);
    const existing = await storage.getWebSession(scope, need.platformId, credentialKey);
    if (existing?.status === "ready" && existing.expiresAt &&
        existing.expiresAt.getTime() > Date.now() + SESSION_FRESH_MARGIN_SECONDS * 1000) {
      return; // fresh — nothing to do
    }
    const claimed = await storage.claimWebSessionMint(
      scope, need.platformId, credentialKey, staleMintThresholdSeconds(), SESSION_FRESH_MARGIN_SECONDS);
    if (!claimed) return; // another instance is minting, or it turned fresh
    try {
      if (!(await brokerAvailable("auth-session"))) {
        throw new Error("no live auth-session broker registered");
      }
      const email = await resolveScopeSecret(scope, need.emailSecret);
      const password = await resolveScopeSecret(scope, need.passwordSecret);
      if (!email || !password) {
        throw new Error(`login secrets ${need.emailSecret}/${need.passwordSecret} not found in scope`);
      }
      const target = await routeToBroker("auth-session");
      if (!target) throw new Error("no auth-session broker available");
      const mintResult = (await mintViaBroker(target, { platformId: need.platformId, email, password }, fetchImpl)) as
        | { storageState?: unknown }
        | undefined;
      const storageState = mintResult?.storageState;
      if (!storageState || typeof storageState !== "object") throw new Error("broker mint response missing or invalid storageState");
      // Fenced write: if our claim was stale-reclaimed while we minted, this is
      // a no-op and the current claim-holder's mint proceeds undisturbed.
      const stored = await storage.storeWebSessionReady(
        claimed.id, encryptValue(JSON.stringify(storageState)), ttlHours(), claimed.mintStartedAt!);
      console.log(stored
        ? `[SessionBroker] Minted session for platform ${need.platformId}`
        : `[SessionBroker] Mint for platform ${need.platformId} completed but claim was superseded — discarded`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SessionBroker] Mint failed for platform ${need.platformId}: ${msg}`);
      await storage.markWebSessionFailed(claimed.id, msg, claimed.mintStartedAt!);
    }
  } catch (outer) {
    console.error("[SessionBroker] ensureSession error:", outer);
  }
}

/** The immutable per-job session stamp folded into a job snapshot. */
export interface SessionSnapshotStamp {
  platformId: string;
  emailSecret: string;
  passwordSecret: string;
}

export type OwnerSessionStampResult =
  | { kind: "misconfigured"; reason: string }
  | { kind: "ok"; snapshotInjection: SessionSnapshotStamp | null };

/**
 * Evaluate + apply the session decision for an OWNER-dispatched job —
 * the scheduler tick and the schedule run-now route, both of which are
 * owner/creator-gated so they carry NO cross-user dispatch-trust gates (the
 * run route does; it stays inline). Shared so the two owner paths can never
 * drift: a workflow whose platform.setup references login-class secrets MUST
 * be minted via Core, never handed to the agent as durable credentials.
 *
 * Mutates `jobConfig` in place: strips any caller-supplied `sessionInjection`
 * (server-stamped only), then — when a session is needed — stamps the
 * agent-visible `{ platformId }` marker and fire-and-forget pre-warms the
 * session cache. Returns `{ misconfigured }` for a split-class credential pair
 * (the caller rejects/disables), or the immutable `snapshotInjection` to fold
 * into the job snapshot (null when no session is needed).
 */
/**
 * One-stop session-need detection for a workflow: parse the platform setup,
 * resolve the owner scope, and evaluate against the scope's brokered secrets.
 * PURE with respect to side effects (one read query, no config mutation, no
 * mint pre-warm) — safe to call before deciding whether a dispatch may happen
 * at all. Every caller that needs "does this workflow need a session?" derives
 * it from HERE so the answer can't drift between routes.
 */
export async function detectSessionNeed(
  workflow: { ownerId: number; organizationId: number | null; config: unknown },
): Promise<SessionRequirement> {
  const wfConfig = (workflow.config ?? {}) as Record<string, unknown>;
  const setup = parsePlatformSetup(wfConfig.stepsPrefix as string | undefined);
  const scope = sessionScopeForWorkflow(workflow);
  return evaluateSessionRequirement(setup, await getBrokeredSecretNames(scope));
}

export async function stampOwnerSession(
  workflow: { ownerId: number; organizationId: number | null; config: unknown },
  jobConfig: Record<string, unknown>,
  precomputedReq?: SessionRequirement,
): Promise<OwnerSessionStampResult> {
  const scope = sessionScopeForWorkflow(workflow);
  const req = precomputedReq ?? await detectSessionNeed(workflow);
  if (req.kind === "misconfigured") return { kind: "misconfigured", reason: req.reason };

  delete jobConfig.sessionInjection; // server-stamped only — never trust a caller value
  if (req.kind === "need") {
    jobConfig.sessionInjection = { platformId: req.need.platformId };
    void ensureSession(scope, req.need);
    return { kind: "ok", snapshotInjection: { platformId: req.need.platformId, emailSecret: req.need.emailSecret, passwordSecret: req.need.passwordSecret } };
  }
  return { kind: "ok", snapshotInjection: null };
}

/**
 * The only config fields whose ${secrets.X} placeholders the daemon actually
 * resolves: scenario, app, stepsPrefix, stepsSuffix (vox-agentd executeJob).
 * Gating on anything wider would reject runs that work today — and, worse,
 * silently disable a recurring schedule on its next tick. Picked from each
 * config separately rather than via mergeEvalConfig, which throws on
 * conflicting keys and would turn a clean 400 into a 500.
 */
export function resolvableSecretSources(configs: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const cfg of configs) {
    const c = (cfg ?? {}) as Record<string, unknown>;
    out.push(c.scenario, c.app, c.stepsPrefix, c.stepsSuffix);
  }
  return out;
}

/**
 * Names of ${secrets.X} placeholders a workflow/eval-set references that have
 * NO secret row in the owner's scope. Such a run is a GUARANTEED failure: the
 * daemon leaves an unresolved placeholder verbatim, and aeval then aborts on
 * it ("Unknown variable source: secrets") with an opaque PyInstaller exit —
 * so every dispatch path rejects up front instead of burning an agent run.
 *
 * Scope is the WORKFLOW OWNER's (secrets follow workflow ownership), which is
 * the same scope the job-secrets endpoint resolves against at claim time.
 */
export async function missingSecretNames(
  scope: SessionScope,
  configs: unknown[],
): Promise<string[]> {
  const classified = await classifyReferencedSecrets(scope, collectSecretRefs(configs));
  return classified.filter((c) => !c.present).map((c) => c.name);
}

/**
 * Join referenced secret NAMES against the scope's secret rows, attaching each
 * name's brokerType and whether it exists. Names with no matching row default to
 * brokerType null / present:false (a dangling ref delivers nothing).
 */
export async function classifyReferencedSecrets(
  scope: SessionScope,
  names: Set<string>,
): Promise<Array<{ name: string; brokerType: string | null; present: boolean }>> {
  const rows = "userId" in scope
    ? await storage.getSecretsByUserId(scope.userId)
    : await storage.getOrgSecrets(scope.organizationId);
  return Array.from(names).map((name) => {
    const row = rows.find((r) => r.name === name);
    return { name, brokerType: row?.brokerType ?? null, present: !!row };
  });
}

/**
 * A brokered secret is only meaningful as a platform.setup login credential.
 * Returns the names of brokered secrets referenced anywhere OTHER than the
 * given login pair — i.e. misconfigurations the run route must reject.
 */
export function findBrokeredMisuse(
  classified: Array<{ name: string; brokerType: string | null }>,
  loginPair: { emailSecret: string; passwordSecret: string } | null,
): string[] {
  const allowed = new Set(loginPair ? [loginPair.emailSecret, loginPair.passwordSecret] : []);
  return classified.filter((c) => c.brokerType === "auth-session" && !allowed.has(c.name)).map((c) => c.name);
}

const AUTH_FIELD_RE = /USERNAME|PASSWORD|ACCOUNT|EMAIL/i;
/** Default brokerType suggestion for a secret name (Task 6: pre-selects the UI toggle). */
export function defaultBrokerTypeForName(name: string): "auth-session" | null {
  return AUTH_FIELD_RE.test(name) ? "auth-session" : null;
}

// Resolve the brokerType for a secret at create time.
// - undefined body value → name-based default
// - explicit null → runtime (allowed override)
// - explicit string → must be a known type
export function resolveBrokerType(name: string, provided: string | null | undefined):
  { ok: true; brokerType: string | null } | { ok: false; error: string } {
  if (provided === undefined) return { ok: true, brokerType: defaultBrokerTypeForName(name) };
  if (provided === null) return { ok: true, brokerType: null };
  if (!isKnownBrokerType(provided)) return { ok: false, error: `unknown brokerType: ${provided}` };
  return { ok: true, brokerType: provided };
}
