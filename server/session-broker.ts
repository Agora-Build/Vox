/**
 * Phase C session broker — Core side.
 *
 * Core mints login sessions (Playwright storageState) for web eval targets by
 * driving the broker sidecar (aeval `setup:account` headless login), caches
 * them encrypted in web_sessions, and serves them to agents at claim time.
 * Login-class secrets NEVER leave Core; agents only ever see the storageState.
 */
import yaml from "js-yaml";
import { storage, encryptValue, decryptValue, type SessionScope } from "./storage";

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

/** A workflow needs a Core-minted session iff its platform.setup references a login-class secret. */
export function workflowNeedsSession(setup: PlatformSetupInfo | null, loginSecretNames: Set<string>): SessionNeed | null {
  if (!setup) return null;
  if (!setup.emailSecret || !setup.passwordSecret) return null;
  if (!loginSecretNames.has(setup.emailSecret) && !loginSecretNames.has(setup.passwordSecret)) return null;
  return { platformId: setup.platformId, emailSecret: setup.emailSecret, passwordSecret: setup.passwordSecret };
}

export async function getLoginSecretNames(scope: SessionScope): Promise<Set<string>> {
  if ("userId" in scope) {
    const rows = await storage.getSecretsByUserId(scope.userId);
    return new Set(rows.filter(s => s.class === "login").map(s => s.name));
  }
  const rows = await storage.getOrgSecrets(scope.organizationId);
  return new Set(rows.filter(s => s.class === "login").map(s => s.name));
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
export function ttlHours(): number {
  return parseInt(process.env.WEB_SESSION_TTL_HOURS || "12", 10);
}
export function brokerConfigured(): boolean {
  return !!process.env.SESSION_BROKER_URL && !!process.env.SESSION_BROKER_SECRET;
}

type FetchLike = typeof fetch;

async function mintViaBroker(
  req: { platformId: string; email: string; password: string },
  fetchImpl: FetchLike,
): Promise<unknown> {
  const url = `${process.env.SESSION_BROKER_URL!.replace(/\/$/, "")}/mint`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SESSION_BROKER_SECRET}`,
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout((mintTimeoutSeconds() + 15) * 1000),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = ((await resp.json()) as { error?: string }).error ?? ""; } catch { /* non-JSON error body */ }
    throw new Error(`broker mint failed (${resp.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = (await resp.json()) as { storageState?: unknown };
  if (!body.storageState || typeof body.storageState !== "object") {
    throw new Error("broker returned no storageState");
  }
  return body.storageState;
}

/**
 * Mint-if-needed. Safe to fire-and-forget: single-flight via the DB claim, all
 * failures recorded on the row (status='failed', lastError). Never throws.
 */
export async function ensureSession(
  scope: SessionScope, need: SessionNeed, fetchImpl: FetchLike = fetch,
): Promise<void> {
  try {
    const existing = await storage.getWebSession(scope, need.platformId);
    if (existing?.status === "ready" && existing.expiresAt &&
        existing.expiresAt.getTime() > Date.now() + SESSION_FRESH_MARGIN_SECONDS * 1000) {
      return; // fresh — nothing to do
    }
    const claimed = await storage.claimWebSessionMint(
      scope, need.platformId, mintTimeoutSeconds(), SESSION_FRESH_MARGIN_SECONDS);
    if (!claimed) return; // another instance is minting, or it turned fresh
    try {
      if (!brokerConfigured()) throw new Error("session broker not configured (SESSION_BROKER_URL/SECRET)");
      const email = await resolveScopeSecret(scope, need.emailSecret);
      const password = await resolveScopeSecret(scope, need.passwordSecret);
      if (!email || !password) {
        throw new Error(`login secrets ${need.emailSecret}/${need.passwordSecret} not found in scope`);
      }
      const storageState = await mintViaBroker({ platformId: need.platformId, email, password }, fetchImpl);
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
