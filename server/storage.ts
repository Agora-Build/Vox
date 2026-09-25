import * as yaml from "js-yaml";
import {
  PHONE_NUMBER_RE, illegalPhoneStepType, illegalWebStepType, illegalWebVocabInPhone,
  walkStepList, type StepSegment,
} from "@shared/steps";
export { stepsContainCallDial } from "@shared/steps";
import {
  type User,
  type InsertUser,
  type Organization,
  type InsertOrganization,
  type Provider,
  type InsertProvider,
  type RegionLocation,
  type InsertRegionLocation,
  generateProviderId,
  type Project,
  type InsertProject,
  type Evalflow,
  type InsertEvalflow,
  type EvalSet,
  type InsertEvalSet,
  type EvalAgentToken,
  type InsertEvalAgentToken,
  type EvalAgent,
  type InsertEvalAgent,
  type EvalSchedule,
  type InsertEvalSchedule,
  type EvalJob,
  type InsertEvalJob,
  type JobSnapshot,
  type EvalResult,
  type InsertEvalResult,
  type ApiKey,
  type InsertApiKey,
  type PricingConfig,
  type InsertPricingConfig,
  type PaymentMethod,
  type InsertPaymentMethod,
  type PaymentHistory,
  type InsertPaymentHistory,
  type OrganizationSeat,
  type InsertOrganizationSeat,
  type SystemConfig,
  type InsertSystemConfig,
  type FundReturnRequest,
  type InsertFundReturnRequest,
  type Secret,
  type ClashAgentProfile,
  type InsertClashAgentProfile,
  type ClashMatch,
  type InsertClashMatch,
  type ClashResult,
  type InsertClashResult,
  type ClashEloRating,
  type ClashEvent,
  type InsertClashEvent,
  type ClashRunner,
  type ClashTranscript,
  type ClashSchedule,
  type InsertClashSchedule,
  type ClashRunnerIssuedToken,
  type InsertClashRunnerIssuedToken,
  type UserStorageConfig,
  type InsertUserStorageConfig,
  type OrgSecret,
  type WebSession,
  type InsertBrokerRegistrationToken,
  type BrokerRegistrationToken,
  type InsertBroker,
  type Broker,
  users,
  organizations,
  providers,
  regionLocations,
  projects,
  evalflows,
  evalSets,
  evalAgentTokens,
  evalAgents,
  evalSchedules,
  evalJobs,
  evalResults,
  apiKeys,
  pricingConfig,
  paymentMethods,
  paymentHistories,
  organizationSeats,
  activationTokens,
  inviteTokens,
  systemConfig,
  fundReturnRequests,
  secrets,
  clashAgentProfiles,
  clashMatches,
  clashResults,
  clashEloRatings,
  clashEvents,
  clashRunnerPool,
  clashRunnerIssuedTokens,
  clashTranscripts,
  clashSchedules,
  userStorageConfig,
  orgSecrets,
  webSessions,
  brokerRegistrationTokens,
  brokers,
} from "@shared/schema";
import { regionSiteSequence, haversineKm, type RegionCandidate } from "@shared/regions";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { asc, desc, eq, and, or, not, sql, gte, lte, inArray, isNotNull, isNull } from "drizzle-orm";
import crypto from "crypto";

// Realtime-metrics windowing policy (server-owned; the client never sets these).
// Windows spanning <= 90 days return raw per-test points (capped by the ceiling
// as a safety net); longer windows are aggregated into daily buckets so payload
// stays bounded as history grows. "All time" is bounded to the last 3 years.
// See DatabaseStorage.tierMetrics().
const METRICS_RAW_MAX_DAYS = 90;
const METRICS_RAW_ROW_CEILING = 20000;
const METRICS_ALL_MAX_DAYS = 3 * 365; // "all time" shows at most the last 3 years

export type MetricTier = "mainline" | "community" | "myEvals";
export type MetricsMode = "raw" | "bucketDay";
export type RegionQueryScope = {
  siteId?: string;
  baseIds?: string[];
  unverified?: boolean;
};

// Pure raw-vs-bucket decision for a window of `spanDays`. Exported for testing.
export function resolveMetricsMode(spanDays: number): MetricsMode {
  return spanDays > METRICS_RAW_MAX_DAYS ? "bucketDay" : "raw";
}

// The subset of eval-result columns the metrics dashboard consumes. Raw rows
// (full EvalResult) and daily-bucket aggregates both satisfy this shape.
export type MetricSourceRow = Pick<EvalResult,
  | "id" | "providerId" | "siteId"
  | "responseLatencyMedian" | "responseLatencySd" | "responseLatencyP95"
  | "interruptLatencyMedian" | "interruptLatencySd" | "interruptLatencyP95"
  | "turnSuccessRate"
  | "networkResilience" | "naturalness" | "noiseReduction" | "createdAt">
  // Evalflow identity, from the job snapshot. Present only on raw (non-bucketed)
  // rows, where each point maps to one job → one evalflow; null on daily buckets
  // (which average many evalflows) and when the snapshot predates the field.
  & { evalflowId?: number | null; evalflowName?: string | null }
  // Transport partition the row came from (design 2026-09-21 §11) — a constant
  // per query since transports are never mixed in one view.
  & { transport?: "web" | "phone" };

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

export function generateEvalAgentToken(): string {
  return "ev" + crypto.randomBytes(15).toString('hex');
}

// Broker registration token — same shape as an eval agent token so both read
// as a short typed prefix + 30 hex chars (32 total): "ev" for eval agents,
// "bk" for brokers.
export function generateBrokerRegistrationToken(): string {
  return "bk" + crypto.randomBytes(15).toString('hex');
}

// AES-256-GCM encryption for secrets
// CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)
// Ciphertext format: v1:iv:authTag:data (versioned for future key rotation)

const CIPHER_VERSION = "v1";
let _cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a valid 64-char hex string (32 bytes)");
  }
  _cachedKey = Buffer.from(keyHex, "hex");
  return _cachedKey;
}

export function isEncryptionConfigured(): boolean {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  return !!keyHex && /^[0-9a-f]{64}$/i.test(keyHex);
}

export function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_VERSION}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptValue(stored: string): string {
  const parts = stored.split(":");
  // Support versioned format (v1:iv:tag:data) and legacy unversioned (iv:tag:data)
  let ivB64: string, tagB64: string, dataB64: string;
  if (parts[0] === "v1") {
    [, ivB64, tagB64, dataB64] = parts;
  } else {
    // Legacy format: iv:tag:data (no version prefix)
    [ivB64, tagB64, dataB64] = parts;
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

const MAX_CONFIG_SIZE = 100_000; // 100KB

// Keys owned exclusively by the eval set (the test body).
const EVALSET_ONLY_KEYS = ["scenario"] as const;
// Keys owned exclusively by the evalflow (platform setup + connection).
const EVALFLOW_ONLY_KEYS = ["framework", "stepsPrefix", "stepsSuffix"] as const;

export function validateEvalflowConfig(config: unknown, transport: "web" | "phone" = "web"): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  // Size cap FIRST — before any YAML parse, so an oversized or alias-heavy
  // document is rejected on cheap string length, not after expansion.
  if (JSON.stringify(config).length > MAX_CONFIG_SIZE) {
    return { valid: false, error: "Config too large (max 100KB)" };
  }
  const c = config as Record<string, unknown>;
  for (const k of EVALSET_ONLY_KEYS) {
    if (k in c) {
      return { valid: false, error: `'${k}' belongs to the eval set, not the evalflow` };
    }
  }
  if (c.framework !== undefined && c.framework !== "aeval") {
    return { valid: false, error: "Framework must be 'aeval' (voice-agent-tester was removed)" };
  }
  if (c.app !== undefined) {
    return { valid: false, error: "'app' belonged to the removed voice-agent-tester framework" };
  }
  if (c.stepsPrefix !== undefined && typeof c.stepsPrefix !== "string") {
    return { valid: false, error: "Config stepsPrefix must be a string" };
  }
  if (c.stepsSuffix !== undefined && typeof c.stepsSuffix !== "string") {
    return { valid: false, error: "Config stepsSuffix must be a string" };
  }
  // Clean cut (design 2026-09-25 §4): the per-mode config keys are gone; phone
  // specifics are Libretto steps in the shared Setup/Teardown fields.
  if (c.phoneDial !== undefined) {
    return { valid: false, error: "phoneDial was replaced by a call.dial step in Setup Steps (stepsPrefix)" };
  }
  if (c.restfulTrigger !== undefined) {
    return { valid: false, error: "restfulTrigger was replaced by a restful.request step in Setup Steps (stepsPrefix)" };
  }
  if (typeof c.stepsPrefix === "string") {
    const v = validateStepsScript(c.stepsPrefix, transport, "stepsPrefix");
    if (!v.valid) return v;
  }
  if (typeof c.stepsSuffix === "string") {
    const v = validateStepsScript(c.stepsSuffix, transport, "stepsSuffix");
    if (!v.valid) return v;
  }
  return { valid: true };
}

// ---- Setup/Teardown step-script validation (design 2026-09-25 §1/§5) --------
// Save-time vocabulary gate: the LAYOUT is identical for every Evaluation Mode
// (two YAML step lists), but each mode owns a vocabulary — web scripts can't
// contain call.*, phone scripts can't contain platform.*/browser.*. Deeper
// per-step semantics stay with the executors (daemon compiler / aeval); this
// guards only what would certainly fail at run time, with clear errors.
const STEP_EXACT_COMMON = new Set(["lab.trace", "wait", "log"]);
const STEP_PREFIXES_COMMON = ["audio.", "control."];

export function validateStepsScript(
  yamlText: string,
  transport: "web" | "phone",
  field: "stepsPrefix" | "stepsSuffix",
): { valid: boolean; error?: string } {
  if (yamlText.trim() === "") return { valid: true };
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (e) {
    // Web scripts are aeval's domain and legacy rows carry shapes we never
    // parsed at save time — keep them pass-through (zero behavior change).
    // Phone is a new strict mode: its scripts must parse.
    if (transport === "web") return { valid: true };
    return { valid: false, error: `${field}: not valid YAML (${e instanceof Error ? e.message.split("\n")[0] : "parse error"})` };
  }
  if (parsed === null || parsed === undefined) return { valid: true };
  if (!Array.isArray(parsed)) {
    // Non-list YAML (e.g. the legacy `platform:\n  setup:` mapping form) is a
    // legitimate web shape consumed downstream; only phone requires the step
    // list (the daemon compiler enumerates it).
    if (transport === "web") return { valid: true };
    return { valid: false, error: `${field} must be a YAML list of steps` };
  }

  if (transport === "web") {
    // Cross-mode rejection ONLY (recursive — for_each nests steps): aeval
    // owns the web vocabulary, so unknown types pass through and fail at run
    // time there, exactly as before this validator existed.
    const err = walkStepList(parsed, (step) => {
      const type = typeof step.type === "string" ? step.type : "";
      return illegalWebStepType(type);
    });
    if (err === "too-complex") return { valid: false, error: `${field}: step script too complex (aliases/nesting)` };
    if (err) return { valid: false, error: `${field}: ${err}` };
    return { valid: true };
  }

  // Phone: strict, recursive, node/depth-bounded (YAML aliases expand a naive
  // walk exponentially — walkStepList fails closed on the budget).
  const segment: StepSegment = field === "stepsSuffix" ? "teardown" : "setup";
  // Ordering is POSITIONAL, so check it over the raw top-level array — the
  // walk below dedupes aliased nodes by identity, which would let a repeated
  // alias skip a position-dependent rule.
  let dialCount = 0;
  if (segment === "setup") {
    let seenNonRestful = false;
    for (let i = 0; i < parsed.length; i++) {
      const el: unknown = parsed[i];
      const t = typeof el === "object" && el !== null ? String((el as Record<string, unknown>).type ?? "") : "";
      if (t === "restful.request") {
        if (seenNonRestful) {
          return { valid: false, error: `${field}[${i}]: restful.request steps must lead Setup Steps — they execute before the call` };
        }
      } else {
        seenNonRestful = true;
      }
      // Counted here over the RAW array (an aliased dial repeated at the top
      // level would be deduped by the walk below); nested dials are counted
      // in the walk visitor at depth > 0.
      if (t === "call.dial" && ++dialCount > 1) {
        return { valid: false, error: `${field}[${i}]: a phone job places exactly ONE call — remove the extra call.dial` };
      }
    }
  }
  const err = walkStepList(parsed, (step, depth) => {
    const type = typeof step.type === "string" ? step.type : "";
    if (!type) return "each step needs a string 'type'";
    // A templated type could resolve to anything post-substitution — the
    // daemon compiler re-enforces the policy there, but the smuggle shape is
    // rejected here so authors get the error at save.
    if (type.includes("${")) return `templated step type '${type}' is not allowed`;
    const webVocab = illegalWebVocabInPhone(type);
    if (webVocab) return webVocab;
    const common = STEP_EXACT_COMMON.has(type) || STEP_PREFIXES_COMMON.some((p) => type.startsWith(p));
    const phoneOnly = type.startsWith("call.") || type === "restful.request";
    if (!common && !phoneOnly) return `unknown step type '${type}' for phone transport`;

    if (type === "restful.request") {
      if (segment === "teardown") return "restful.request is a Setup (pre-call) step — illegal in Teardown";
      // Orchestrated class: only legal as the LEADING top-level run of Setup
      // (positional rule checked above; a nested one can never execute pre-call).
      if (depth > 0) return "restful.request cannot be nested — it must lead Setup Steps";
      // Deliberately do NOT strip a `steps` key: validateRestfulTrigger flags
      // it as unknown, matching what the endpoint would reject at run time.
      const { type: _t, description: _d, ...fields } = step;
      const shape = validateRestfulTrigger(fields);
      if (!shape.valid) return shape.error ?? "invalid restful.request";
      return null;
    }
    const segErr = illegalPhoneStepType(type, segment);
    if (segErr) return segErr;
    if (type === "call.dial") {
      // ONE call per job (compiler re-enforces post-substitution, where a
      // for_each over numbers would multiply dials past this literal count).
      // Top-level dials were counted positionally above; only nested ones
      // are added here (the walk visits top-level nodes too — skip those).
      if (depth > 0 && ++dialCount > 1) return "a phone job places exactly ONE call — remove the extra call.dial";
      // A literal number must match the dialable shape; a templated number
      // (for_each item) is allowed here and re-checked by the compiler after
      // substitution — the enforcement boundary.
      const num = step.number;
      if (typeof num !== "string" || (!num.includes("${") && !PHONE_NUMBER_RE.test(num))) {
        return "call.dial needs number: '<phone number>'";
      }
    }
    return null;
  });
  if (err === "too-complex") return { valid: false, error: `${field}: step script too complex (aliases/nesting)` };
  if (err) return { valid: false, error: `${field}: ${err}` };
  return { valid: true };
}


/**
 * Best-effort parse of a Setup/Teardown YAML step list. Returns [] for empty,
 * unparseable, or non-list input — callers gate on step presence, and an
 * invalid script already failed save-time validation (this tolerates legacy
 * snapshot configs without throwing).
 */
export function parseStepsScript(yamlText: unknown): Array<Record<string, unknown>> {
  if (typeof yamlText !== "string" || yamlText.trim() === "") return [];
  try {
    const parsed = yaml.load(yamlText);
    if (!Array.isArray(parsed)) return [];
    // Indices are a WIRE CONTRACT (the restful endpoint addresses steps by
    // stepIndex, computed by the daemon over the raw list) — map non-object
    // entries to {} rather than filtering, so positions never shift.
    return parsed.map((s): Record<string, unknown> =>
      typeof s === "object" && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : {});
  } catch {
    return [];
  }
}



// Shape-only validation of a restful.request step's fields (design 2026-09-21 §5,
// unified-steps 2026-09-25 §1): the template an orchestrated REST call executes.
// Template placeholders are deliberately NOT resolved here — Core resolves them
// from the frozen snapshot at execution time.
const RESTFUL_TRIGGER_KEYS = new Set(["method", "url", "headers", "body", "expectStatus", "timeoutMs"]);
const RESTFUL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export const RESTFUL_TIMEOUT_CAP_MS = 120_000;
export function validateRestfulTrigger(raw: unknown): { valid: boolean; error?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "restful.request fields must be an object" };
  }
  const t = raw as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!RESTFUL_TRIGGER_KEYS.has(k)) return { valid: false, error: `restful.request: unknown field '${k}'` };
  }
  if (typeof t.method !== "string" || !RESTFUL_METHODS.has(t.method)) {
    return { valid: false, error: "restful.request method must be GET/POST/PUT/PATCH/DELETE" };
  }
  if (typeof t.url !== "string") return { valid: false, error: "restful.request url must be a string" };
  // Placeholders may appear in the path/query but not the scheme/host position.
  let parsed: URL;
  try { parsed = new URL(t.url); } catch { return { valid: false, error: "restful.request url is not a valid URL" }; }
  const httpOkay = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !httpOkay) {
    return { valid: false, error: "restful.request url must be https (http allowed for localhost only)" };
  }
  if (t.headers !== undefined) {
    if (typeof t.headers !== "object" || t.headers === null || Array.isArray(t.headers)
      || Object.values(t.headers as Record<string, unknown>).some((v) => typeof v !== "string")) {
      return { valid: false, error: "restful.request headers must be a string map" };
    }
  }
  if (t.expectStatus !== undefined) {
    if (!Array.isArray(t.expectStatus) || t.expectStatus.length === 0
      || t.expectStatus.some((s) => !Number.isInteger(s) || (s as number) < 100 || (s as number) > 599)) {
      return { valid: false, error: "restful.request expectStatus must be a non-empty array of HTTP status codes" };
    }
  }
  if (t.timeoutMs !== undefined) {
    if (!Number.isInteger(t.timeoutMs) || (t.timeoutMs as number) <= 0 || (t.timeoutMs as number) > RESTFUL_TIMEOUT_CAP_MS) {
      return { valid: false, error: `restful.request timeoutMs must be 1..${RESTFUL_TIMEOUT_CAP_MS}` };
    }
  }
  return { valid: true };
}

export function validateEvalSetConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "Config must be an object" };
  }
  // Size cap FIRST — before any YAML parse (see validateEvalflowConfig).
  if (JSON.stringify(config).length > MAX_CONFIG_SIZE) {
    return { valid: false, error: "Config too large (max 100KB)" };
  }
  const c = config as Record<string, unknown>;
  for (const k of EVALFLOW_ONLY_KEYS) {
    if (k in c) {
      return { valid: false, error: `'${k}' belongs to the evalflow, not the eval set` };
    }
  }
  if (c.scenario !== undefined && typeof c.scenario !== "string") {
    return { valid: false, error: "Config scenario must be a string" };
  }
  // SECURITY: the conversation must never place/end calls or fire REST
  // requests — those are evalflow Setup/Teardown vocabulary, and an eval set
  // can be a public third-party artifact combined with someone else's SIM
  // (a conversation-injected call.dial is toll fraud). The daemon splitter
  // enforces the same rule at run time; this rejects it at save.
  if (typeof c.scenario === "string" && c.scenario.trim() !== "") {
    let doc: unknown;
    try { doc = yaml.load(c.scenario); } catch { doc = null; /* aeval's parse problem, not ours */ }
    const steps = (doc as { steps?: unknown } | null)?.steps;
    const illegal = Array.isArray(steps) ? findIllegalScenarioStep(steps) : null;
    if (illegal === "too-complex") {
      return { valid: false, error: "scenario: step script too complex (aliases/nesting)" };
    }
    if (illegal) {
      return { valid: false, error: `scenario: ${illegal}` };
    }
  }
  return { valid: true };
}

/** Bounded scan of an eval-set conversation for step types that belong to
 * the evalflow (call-control / REST / SMS) — plus templated types, which
 * could resolve to those post-substitution (the daemon compiler is the
 * enforcement boundary; this rejects the smuggle shape at save). Returns an
 * error string, "too-complex" when the walk budget is exceeded (fail
 * closed), else null. */
function findIllegalScenarioStep(steps: unknown[]): string | null {
  return walkStepList(steps, (step) => {
    const type = typeof step.type === "string" ? step.type : "";
    const err = illegalPhoneStepType(type, "conversation");
    if (err) return err;
    if (type.includes("${")) return `templated step type '${type}' is not allowed`;
    return null;
  });
}


export function mergeEvalConfig(
  evalflowConfig: unknown,
  evalSetConfig: unknown,
): Record<string, unknown> {
  const wf = (evalflowConfig as Record<string, unknown>) || {};
  const es = (evalSetConfig as Record<string, unknown>) || {};
  // Role-disjointness (scenario vs framework/app/steps*) is enforced by the
  // validators. Here we only guard against the evalflow and eval set sharing a
  // key with CONFLICTING values (e.g. a frameworkVersion mismatch). Identical
  // shared values are fine — the eval set's value is used.
  // Shared keys are scalars (e.g. frameworkVersion), so JSON.stringify compares
  // them reliably; revisit with a canonical compare if object-valued shared keys
  // ever appear.
  const conflicts = Object.keys(wf).filter(
    (k) => k in es && JSON.stringify(wf[k]) !== JSON.stringify(es[k]),
  );
  if (conflicts.length > 0) {
    throw new Error(`Evalflow and eval set configs share keys with conflicting values: ${conflicts.join(", ")}`);
  }
  return { ...wf, ...es };
}

// Build the immutable per-job snapshot (see JobSnapshot in shared/schema). Captures
// the metadata + config + tier flags of the evalflow/eval-set/provider at run time so
// provenance, attribution, and metric tiering never drift when those rows change.
export function buildJobSnapshot(
  evalflow: Evalflow,
  evalSet: EvalSet | undefined | null,
  provider: Provider | undefined | null,
  creatorPlan: string | null,
): JobSnapshot {
  return {
    provider: provider
      ? { id: provider.id, name: provider.name, platformId: provider.platformId ?? null }
      : null,
    evalflow: {
      name: evalflow.name,
      config: evalflow.config,
      visibility: evalflow.visibility,
      isMainline: evalflow.isMainline,
      ownerId: evalflow.ownerId,
      organizationId: evalflow.organizationId ?? null,
    },
    evalSet: evalSet
      ? {
          name: evalSet.name,
          config: evalSet.config,
          visibility: evalSet.visibility,
          isMainline: evalSet.isMainline,
          ownerId: evalSet.ownerId,
        }
      : null,
    creatorPlan,
    transport: (evalflow.transport as "web" | "phone" | undefined) ?? "web",
  };
}

// Helper to convert snake_case SQL results to camelCase for type safety
function snakeToCamel(row: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key in row) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = row[key];
  }
  return result;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
export { pool };

// session broker: a web_sessions row is owned by exactly one of a user
// or an organization (mirrors secrets ownership).
export type SessionScope = { userId: number } | { organizationId: number };

export class DatabaseStorage {
  // org-columns: provider — returns the raw User row (organizationId/orgRole
  // included). Those two columns are FROZEN since the Release A flip: membership
  // comes from the vox.organizations plugin, and Release B drops them.
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.googleId, googleId));
    return result[0];
  }

  async getUserByGithubId(githubId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.githubId, githubId));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  // Compensating delete for register-with-invite: createUser and the
  // org-membership write (through the vox.organizations seam) are two
  // separate statements, not one transaction, so a failure in the second
  // needs to unwind the first to match BASE's atomicity (a single INSERT
  // that either fully landed or fully didn't). Not a general user-deletion
  // feature — there is deliberately no admin-facing route for this.
  async deleteUser(id: number): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  // org-columns: provider — generic column setter. The deleted built-in provider
  // wrote organizationId/orgRole through it; post-flip no caller does.
  async updateUser(id: number, data: Partial<User>): Promise<User | undefined> {
    const result = await db.update(users).set({ ...data, updatedAt: new Date() }).where(eq(users.id, id)).returning();
    return result[0];
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  // org-columns: provider — batch row fetch behind the deleted built-in
  // provider's getMemberships(); still used by non-org batch callers.
  async getUsersByIds(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return db.select().from(users).where(inArray(users.id, Array.from(new Set(ids))));
  }

  // Test-only org seeder: writes the frozen public.organizations table directly.
  // Production creates orgs through the vox.organizations seam
  // (orgs.createOrganization). This and upsertOrgSecretRow below are the last
  // storage.ts org writers left after the Release B dead-code cleanup — kept
  // only for the test seeders that target the Core tables Release B finally drops.
  async createOrganization(org: InsertOrganization): Promise<Organization> {
    const result = await db.insert(organizations).values(org).returning();
    return result[0];
  }

  async createProvider(provider: Omit<InsertProvider, 'id'>): Promise<Provider> {
    const id = generateProviderId();
    const result = await db.insert(providers).values({ ...provider, id }).returning();
    return result[0];
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    const result = await db.select().from(providers).where(eq(providers.id, id));
    return result[0];
  }

  async getAllProviders(): Promise<Provider[]> {
    return db.select().from(providers).where(eq(providers.isActive, true)).orderBy(desc(providers.createdAt));
  }

  // Unfiltered by isActive (unlike getAllProviders) — used by /api/auth/init to
  // guard seeding so a deactivated provider can't slip past the name check and
  // create a duplicate row.
  async getProviderByName(name: string): Promise<Provider | undefined> {
    const result = await db.select().from(providers).where(eq(providers.name, name));
    return result[0];
  }

  async updateProvider(id: string, data: Partial<Provider>): Promise<Provider | undefined> {
    const result = await db.update(providers).set({ ...data, updatedAt: new Date() }).where(eq(providers.id, id)).returning();
    return result[0];
  }

  async getAllRegionLocations(): Promise<RegionLocation[]> {
    return db.select().from(regionLocations).orderBy(regionLocations.macroRegionName, regionLocations.countryName, regionLocations.city);
  }

  async getActiveRegionLocations(): Promise<RegionLocation[]> {
    return db.select().from(regionLocations)
      .where(eq(regionLocations.isActive, true))
      .orderBy(regionLocations.macroRegionName, regionLocations.countryName, regionLocations.city);
  }

  async getRegionLocation(id: number): Promise<RegionLocation | undefined> {
    const result = await db.select().from(regionLocations).where(eq(regionLocations.id, id));
    return result[0];
  }

  async getRegionLocationByBaseId(baseId: string): Promise<RegionLocation | undefined> {
    const result = await db.select().from(regionLocations).where(eq(regionLocations.baseId, baseId));
    return result[0];
  }

  async createRegionLocation(location: InsertRegionLocation): Promise<RegionLocation> {
    const result = await db.insert(regionLocations).values(location).returning();
    return result[0];
  }

  async findNearestActiveRegion(lat: number, lon: number, maxKm: number): Promise<RegionLocation | undefined> {
    // Catalog is small (tens of rows) — fetch and haversine in JS.
    const rows = await db.select().from(regionLocations)
      .where(eq(regionLocations.isActive, true));
    let best: { row: RegionLocation; km: number } | undefined;
    for (const row of rows) {
      if (row.latitude == null || row.longitude == null) continue;
      const km = haversineKm(lat, lon, row.latitude, row.longitude);
      if (km <= maxKm && (!best || km < best.km)) best = { row, km };
    }
    return best?.row;
  }

  async createDetectedRegionLocation(candidate: RegionCandidate): Promise<RegionLocation> {
    try {
      const result = await db.insert(regionLocations).values({
        baseId: candidate.baseId,
        displayName: candidate.displayName,
        city: candidate.city,
        countryCode: candidate.countryCode,
        countryName: candidate.countryName,
        macroRegionCode: candidate.macroRegionCode,
        macroRegionName: candidate.macroRegionName,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        source: "detected",
        isMainline: false,
        isActive: true,
      }).returning();
      return result[0];
    } catch (err) {
      // Unique base_id race: another agent created it first — reuse.
      const existing = await this.getRegionLocationByBaseId(candidate.baseId);
      if (existing) return existing;
      throw err;
    }
  }

  async updateRegionLocation(id: number, data: Partial<RegionLocation>): Promise<RegionLocation | undefined> {
    const result = await db.update(regionLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(regionLocations.id, id))
      .returning();
    return result[0];
  }

  async resolveRegionLocation(region: string): Promise<RegionLocation | undefined> {
    const locations = await this.getAllRegionLocations();
    return locations
      .sort((a, b) => b.baseId.length - a.baseId.length)
      .find((location) => regionSiteSequence(region, location.baseId) !== null);
  }

  async isAllocatedSite(siteId: string, activeOnly = true): Promise<boolean> {
    const location = await this.resolveRegionLocation(siteId);
    if (!location || (activeOnly && !location.isActive)) return false;
    const sequence = regionSiteSequence(siteId, location.baseId);
    return sequence !== null && sequence < location.nextSequence;
  }

  // Extracted from createEvalAgentTokenForLocation so any allocation-needing
  // caller (agent location checks, not just token minting) can grab the next
  // sequential siteId for a region without duplicating the locking transaction.
  async allocateSiteId(baseId: string): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT base_id, next_sequence, is_active FROM region_locations WHERE base_id = $1 FOR UPDATE`,
        [baseId],
      );
      if (selected.rows.length === 0) throw new Error("Region location not found");
      if (!selected.rows[0].is_active) throw new Error("Region location is inactive");
      const sequence = Number(selected.rows[0].next_sequence);
      const siteId = `${selected.rows[0].base_id}-${String(sequence).padStart(2, "0")}`;
      await client.query(
        `UPDATE region_locations SET next_sequence = next_sequence + 1, updated_at = NOW() WHERE base_id = $1`,
        [baseId],
      );
      await client.query("COMMIT");
      return siteId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createEvalAgentTokenForLocation(
    baseId: string,
    token: Omit<InsertEvalAgentToken, "siteId">,
  ): Promise<EvalAgentToken> {
    // Allocate first, then a plain insert. A burned sequence number on insert
    // failure (e.g. a constraint violation on the token row) is harmless — the
    // catalog just skips ahead one, no different from a rolled-back racer.
    const siteId = await this.allocateSiteId(baseId);
    const result = await db.insert(evalAgentTokens).values({
      ...token,
      siteId,
      region: baseId,
    }).returning();
    return result[0];
  }

  async createEvalAgentTokenWithoutLocation(token: Omit<InsertEvalAgentToken, "siteId">): Promise<EvalAgentToken> {
    const result = await db.insert(evalAgentTokens).values({
      ...token, siteId: null, region: null,
    }).returning();
    return result[0];
  }

  async updateEvalAgentLocation(agentId: number, fields: {
    region: string | null; siteId: string | null; locationTrust: string;
    locationCheckedAt: Date; locationSource: unknown;
    pendingRegion: string | null; pendingRegionCount: number;
  }): Promise<void> {
    await db.update(evalAgents).set({
      region: fields.region,
      siteId: fields.siteId,
      locationTrust: fields.locationTrust,
      locationCheckedAt: fields.locationCheckedAt,
      locationSource: fields.locationSource,
      pendingRegion: fields.pendingRegion,
      pendingRegionCount: fields.pendingRegionCount,
      updatedAt: new Date(),
    }).where(eq(evalAgents.id, agentId));
  }

  // Public-tier agents: configured identity (region/siteId) is trusted and never
  // touched here — only the observability fields are recorded.
  async updateEvalAgentLocationObservability(agentId: number, fields: {
    locationTrust: string; locationCheckedAt: Date; locationSource: unknown;
  }): Promise<void> {
    await db.update(evalAgents).set({
      locationTrust: fields.locationTrust,
      locationCheckedAt: fields.locationCheckedAt,
      locationSource: fields.locationSource,
      updatedAt: new Date(),
    }).where(eq(evalAgents.id, agentId));
  }

  async createProject(project: InsertProject): Promise<Project> {
    const result = await db.insert(projects).values(project).returning();
    return result[0];
  }

  async getProject(id: number): Promise<Project | undefined> {
    const result = await db.select().from(projects).where(eq(projects.id, id));
    return result[0];
  }

  async getProjectsByOwner(ownerId: number): Promise<Project[]> {
    return db.select().from(projects).where(eq(projects.ownerId, ownerId)).orderBy(desc(projects.createdAt));
  }

  async getProjectsByOrganization(organizationId: number): Promise<Project[]> {
    return db.select().from(projects).where(eq(projects.organizationId, organizationId)).orderBy(desc(projects.createdAt));
  }

  async updateProject(id: number, data: Partial<Project>): Promise<Project | undefined> {
    const result = await db.update(projects).set({ ...data, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    return result[0];
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async countProjectsByOwner(ownerId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(projects).where(eq(projects.ownerId, ownerId));
    return Number(result[0]?.count || 0);
  }

  async createEvalflow(evalflow: InsertEvalflow): Promise<Evalflow> {
    const result = await db.insert(evalflows).values(evalflow).returning();
    return result[0];
  }

  async getEvalflow(id: number): Promise<Evalflow | undefined> {
    const result = await db.select().from(evalflows).where(eq(evalflows.id, id));
    return result[0];
  }

  async getEvalflowsByOwner(ownerId: number): Promise<Evalflow[]> {
    return db.select().from(evalflows).where(eq(evalflows.ownerId, ownerId)).orderBy(desc(evalflows.createdAt));
  }

  async getEvalflowsByOrganization(organizationId: number): Promise<Evalflow[]> {
    return db.select().from(evalflows).where(eq(evalflows.organizationId, organizationId)).orderBy(desc(evalflows.createdAt));
  }

  async getEvalflowsByProject(projectId: number): Promise<Evalflow[]> {
    return db.select().from(evalflows).where(eq(evalflows.projectId, projectId)).orderBy(desc(evalflows.createdAt));
  }

  async getPublicEvalflows(): Promise<Evalflow[]> {
    return db.select().from(evalflows).where(eq(evalflows.visibility, "public")).orderBy(desc(evalflows.createdAt));
  }

  async getMainlineEvalflows(): Promise<Evalflow[]> {
    return db.select().from(evalflows).where(eq(evalflows.isMainline, true)).orderBy(desc(evalflows.createdAt));
  }

  async updateEvalflow(id: number, data: Partial<Evalflow>): Promise<Evalflow | undefined> {
    const result = await db.update(evalflows).set({ ...data, updatedAt: new Date() }).where(eq(evalflows.id, id)).returning();
    return result[0];
  }

  async deleteEvalflow(id: number): Promise<void> {
    await db.delete(evalflows).where(eq(evalflows.id, id));
  }

  async countEvalflowsByProject(projectId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(evalflows).where(eq(evalflows.projectId, projectId));
    return Number(result[0]?.count || 0);
  }

  async countEvalflowsByOwner(ownerId: number): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(evalflows).where(eq(evalflows.ownerId, ownerId));
    return Number(result[0]?.count || 0);
  }

  async createEvalSet(evalSet: InsertEvalSet): Promise<EvalSet> {
    const result = await db.insert(evalSets).values(evalSet).returning();
    return result[0];
  }

  async getEvalSet(id: number): Promise<EvalSet | undefined> {
    const result = await db.select().from(evalSets).where(eq(evalSets.id, id));
    return result[0];
  }

  async getEvalSetsByOwner(ownerId: number): Promise<EvalSet[]> {
    return db.select().from(evalSets).where(eq(evalSets.ownerId, ownerId)).orderBy(desc(evalSets.createdAt));
  }

  async getEvalSetsByOrganization(organizationId: number): Promise<EvalSet[]> {
    return db.select().from(evalSets).where(eq(evalSets.organizationId, organizationId)).orderBy(desc(evalSets.createdAt));
  }

  async getPublicEvalSets(): Promise<EvalSet[]> {
    return db.select().from(evalSets).where(eq(evalSets.visibility, "public")).orderBy(desc(evalSets.createdAt));
  }

  async updateEvalSet(id: number, data: Partial<EvalSet>): Promise<EvalSet | undefined> {
    const result = await db.update(evalSets).set({ ...data, updatedAt: new Date() }).where(eq(evalSets.id, id)).returning();
    return result[0];
  }

  async deleteEvalSet(id: number): Promise<void> {
    await db.delete(evalSets).where(eq(evalSets.id, id));
  }

  async getEvalJobsByEvalSetId(evalSetId: number): Promise<EvalJob[]> {
    return db.select().from(evalJobs).where(eq(evalJobs.evalSetId, evalSetId));
  }

  async createEvalAgentToken(token: InsertEvalAgentToken): Promise<EvalAgentToken> {
    // Fixtures/tests pass a bare siteId; region is derivable (strip -NN).
    const values = { ...token, region: (token as { region?: string }).region ?? token.siteId?.replace(/-\d+$/, "") ?? null };
    const result = await db.insert(evalAgentTokens).values(values).returning();
    return result[0];
  }

  async getEvalAgentToken(id: number): Promise<EvalAgentToken | undefined> {
    const result = await db.select().from(evalAgentTokens).where(eq(evalAgentTokens.id, id));
    return result[0];
  }

  async getEvalAgentTokenByHash(tokenHash: string): Promise<EvalAgentToken | undefined> {
    const result = await db.select().from(evalAgentTokens).where(eq(evalAgentTokens.tokenHash, tokenHash));
    return result[0];
  }

  async getAllEvalAgentTokens(): Promise<EvalAgentToken[]> {
    return db.select().from(evalAgentTokens).orderBy(desc(evalAgentTokens.createdAt));
  }

  async getEvalAgentTokensByUser(userId: number): Promise<EvalAgentToken[]> {
    return db.select().from(evalAgentTokens).where(eq(evalAgentTokens.createdBy, userId)).orderBy(desc(evalAgentTokens.createdAt));
  }

  async revokeEvalAgentToken(id: number): Promise<void> {
    await db.update(evalAgentTokens).set({ isRevoked: true }).where(eq(evalAgentTokens.id, id));
  }

  async updateEvalAgentTokenDispatchTier(id: number, dispatchTier: string): Promise<void> {
    await db.update(evalAgentTokens)
      .set({ dispatchTier: dispatchTier as typeof evalAgentTokens.$inferInsert["dispatchTier"] })
      .where(eq(evalAgentTokens.id, id));
  }

  async updateEvalAgentTokenLastUsed(id: number): Promise<void> {
    await db.update(evalAgentTokens).set({ lastUsedAt: new Date() }).where(eq(evalAgentTokens.id, id));
  }

  async createEvalAgent(agent: InsertEvalAgent): Promise<EvalAgent> {
    const result = await db.insert(evalAgents).values(agent).returning();
    return result[0];
  }

  async getEvalAgent(id: number): Promise<EvalAgent | undefined> {
    const result = await db.select().from(evalAgents).where(eq(evalAgents.id, id));
    return result[0];
  }

  async getEvalAgentsByRegion(region: string): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).where(eq(evalAgents.siteId, region)).orderBy(desc(evalAgents.createdAt));
  }

  async getEvalAgentsByTokenId(tokenId: number): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).where(eq(evalAgents.tokenId, tokenId)).orderBy(desc(evalAgents.createdAt)).limit(1);
  }

  async getAllEvalAgents(): Promise<EvalAgent[]> {
    return db.select().from(evalAgents).orderBy(desc(evalAgents.createdAt));
  }

  async getEvalAgentsWithTokenTier(): Promise<
    (EvalAgent & {
      tokenCreatedBy: number; tokenDispatchTier: string;
      tokenRegion: string | null; tokenSiteId: string | null; tokenIsRevoked: boolean;
    })[]
  > {
    const results = await db.select({
      id: evalAgents.id,
      name: evalAgents.name,
      tokenId: evalAgents.tokenId,
      siteId: evalAgents.siteId,
      region: evalAgents.region,
      locationTrust: evalAgents.locationTrust,
      state: evalAgents.state,
      lastSeenAt: evalAgents.lastSeenAt,
      lastJobAt: evalAgents.lastJobAt,
      metadata: evalAgents.metadata,
      createdAt: evalAgents.createdAt,
      updatedAt: evalAgents.updatedAt,
      tokenCreatedBy: evalAgentTokens.createdBy,
      tokenDispatchTier: evalAgentTokens.dispatchTier,
      tokenRegion: evalAgentTokens.region,
      // Public-tier tokens carry their admin-configured region/siteId on the
      // TOKEN, not the agent (the agent's own detected region is permanently
      // null for public — see effectiveDispatchIdentity). Selected here so
      // callers can build public-fleet rows from this same join, no second
      // round-trip.
      tokenSiteId: evalAgentTokens.siteId,
      tokenIsRevoked: evalAgentTokens.isRevoked,
    })
      .from(evalAgents)
      .innerJoin(evalAgentTokens, eq(evalAgents.tokenId, evalAgentTokens.id))
      .orderBy(desc(evalAgents.createdAt));
    return results as (EvalAgent & {
      tokenCreatedBy: number; tokenDispatchTier: string;
      tokenRegion: string | null; tokenSiteId: string | null; tokenIsRevoked: boolean;
    })[];
  }

  async updateEvalAgent(id: number, data: Partial<EvalAgent>): Promise<EvalAgent | undefined> {
    const result = await db.update(evalAgents).set({ ...data, updatedAt: new Date() }).where(eq(evalAgents.id, id)).returning();
    return result[0];
  }

  async updateEvalAgentHeartbeat(id: number): Promise<void> {
    await db.update(evalAgents).set({ lastSeenAt: new Date(), state: "idle", updatedAt: new Date() }).where(eq(evalAgents.id, id));
  }

  /**
   * Layer-2/3 foundation: Core-observed egress IP of an agent (register/
   * heartbeat). Raw IP is Core-internal — future phases derive network labels
   * (residential/datacenter/starlink) from it; never expose it publicly.
   * Fire-and-forget safe: call sites use `void ...` on the hot register/
   * heartbeat path, so this method must never reject — a lost sample is
   * harmless, an unhandled rejection would kill the process.
   */
  async updateEvalAgentObservedIp(agentId: number, ip: string): Promise<void> {
    try {
      await db.update(evalAgents)
        .set({ observedIp: ip, observedIpAt: new Date() })
        .where(eq(evalAgents.id, agentId));
    } catch (err) {
      console.error(`[Agents] Failed to record observed IP for agent ${agentId}:`, err instanceof Error ? err.message : err);
    }
  }

  async createBrokerRegistrationToken(t: InsertBrokerRegistrationToken): Promise<BrokerRegistrationToken> {
    const [row] = await db.insert(brokerRegistrationTokens).values(t).returning();
    return row;
  }
  async getBrokerRegistrationTokenByHash(hash: string): Promise<BrokerRegistrationToken | undefined> {
    const [row] = await db.select().from(brokerRegistrationTokens)
      .where(eq(brokerRegistrationTokens.tokenHash, hash));
    return row;
  }
  async getAllBrokerRegistrationTokens(): Promise<BrokerRegistrationToken[]> {
    return db.select().from(brokerRegistrationTokens).orderBy(desc(brokerRegistrationTokens.createdAt));
  }
  async revokeBrokerRegistrationToken(id: number): Promise<void> {
    await db.update(brokerRegistrationTokens).set({ isRevoked: true })
      .where(eq(brokerRegistrationTokens.id, id));
  }
  async updateBrokerRegistrationTokenLastUsed(id: number): Promise<void> {
    await db.update(brokerRegistrationTokens).set({ lastUsedAt: new Date() })
      .where(eq(brokerRegistrationTokens.id, id));
  }
  async createBroker(b: InsertBroker): Promise<Broker> {
    const [row] = await db.insert(brokers).values(b).returning();
    return row;
  }
  async getBroker(id: number): Promise<Broker | undefined> {
    const [row] = await db.select().from(brokers).where(eq(brokers.id, id));
    return row;
  }
  async getBrokersByTokenId(tokenId: number): Promise<Broker[]> {
    return db.select().from(brokers).where(eq(brokers.tokenId, tokenId)).orderBy(desc(brokers.createdAt)).limit(1);
  }
  async getAllBrokers(): Promise<Broker[]> {
    return db.select().from(brokers).orderBy(desc(brokers.createdAt));
  }
  // Distinct brokerType of LIVE (non-offline) brokers — drives the secret
  // broker-type dropdown so it only offers types actually serviceable right now.
  async getLiveBrokerTypes(): Promise<string[]> {
    const rows = await db.selectDistinct({ brokerType: brokers.brokerType })
      .from(brokers).where(sql`${brokers.state} != 'offline'::broker_state`);
    return rows.map((r) => r.brokerType);
  }
  async updateBroker(id: number, data: Partial<InsertBroker>): Promise<Broker | undefined> {
    const [row] = await db.update(brokers).set({ ...data, updatedAt: new Date() })
      .where(eq(brokers.id, id)).returning();
    return row;
  }
  async updateBrokerHeartbeat(id: number): Promise<void> {
    await db.update(brokers).set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(brokers.id, id));
  }
  async updateBrokerObservedIp(id: number, ip: string): Promise<void> {
    try {
      await db.update(brokers).set({ observedIp: ip, observedIpAt: new Date() })
        .where(eq(brokers.id, id));
    } catch (err) {
      console.error(`[Broker] Failed to record observed IP for broker ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  async getRoutableBrokers(brokerType: string, offlineThresholdSeconds: number): Promise<Broker[]> {
    const cutoff = new Date(Date.now() - offlineThresholdSeconds * 1000);
    return db.select().from(brokers).where(and(
      eq(brokers.brokerType, brokerType),
      eq(brokers.state, "idle"),
      gte(brokers.lastSeenAt, cutoff),
    )).orderBy(desc(brokers.lastSeenAt));
  }

  async countTodayJobsByOwner(ownerId: number): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    // Count the jobs this user RAN (created_by) — immutable and survives evalflow
    // deletion, so the daily limit can't be bypassed by deleting the evalflow.
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(evalJobs)
      .where(and(eq(evalJobs.createdBy, ownerId), gte(evalJobs.createdAt, startOfDay)));
    return result[0]?.count ?? 0;
  }

  async createEvalJob(job: InsertEvalJob): Promise<EvalJob> {
    // Stamp the frozen transport column from the snapshot (single choke point —
    // covers the run route AND the scheduler; creator_org_id pattern, design §3).
    const transport = ((job.snapshot as JobSnapshot | null)?.transport ?? "web") as "web" | "phone";
    // Cast: the Zod insert type widens the `snapshot` jsonb ($type<JobSnapshot>)
    // to a looser shape; the runtime value is a valid JobSnapshot.
    const result = await db.insert(evalJobs)
      .values({ ...(job as typeof evalJobs.$inferInsert), transport })
      .returning();
    return result[0];
  }

  async getEvalJob(id: number): Promise<EvalJob | undefined> {
    const result = await db.select().from(evalJobs).where(eq(evalJobs.id, id));
    return result[0];
  }

  async getEvalJobsByAgent(agentId: number): Promise<EvalJob[]> {
    return db.select().from(evalJobs).where(eq(evalJobs.evalAgentId, agentId)).orderBy(desc(evalJobs.createdAt));
  }

  async claimEvalJob(
    jobId: number,
    agentId: number,
    identity: { id: number; siteId: string | null; region: string | null; dispatchTier: string; createdBy: number; ownerOrgId: number | null; locationTrust: string; phoneCapable?: boolean },
  ): Promise<EvalJob | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // WHERE mirrors permissions.isClaimable() bit for bit. A NULL region/siteId
      // (Unverified agent) simply never matches the pooled/legacy arms below —
      // that IS the zero-trust gate; no explicit trust condition needed here.
      const selectResult = await client.query(
        `SELECT ej.* FROM eval_jobs ej
         WHERE ej.id = $1 AND ej.status = 'pending'::eval_job_status
           -- Phone-transport jobs require the phone capability (design §8) —
           -- applies to every arm below, targeted included.
           AND ( ej.transport = 'web'::transport OR $8::boolean = true )
           AND (
             ej.target_token_id = $2
             OR ( ej.target_token_id IS NULL AND ej.target_region IS NOT NULL AND ej.target_region = $3 AND (
                    ( ej.target_tier = 'private'::dispatch_tier AND ej.created_by = $5 )
                 OR ( ej.target_tier = 'team'::dispatch_tier
                      AND $4 IN ('team', 'public')
                      -- R2 (§11): the creator's org FROZEN at creation, not their live
                      -- membership — no users join here by design (seam invariant).
                      AND $6::integer IS NOT NULL AND ej.creator_org_id = $6 )
                 OR ( ej.target_tier = 'public'::dispatch_tier AND $4 = 'public'
                      AND (ej.config -> 'sessionInjection') IS NULL )
             ) )
             OR ( ej.target_token_id IS NULL AND ej.target_region IS NULL AND ej.site_id = $7 AND (
                    ej.created_by = $5
                    OR ( $4 = 'public' AND (ej.config -> 'sessionInjection') IS NULL )
             ) )
           )
         FOR UPDATE OF ej SKIP LOCKED`,
        [jobId, identity.id, identity.region, identity.dispatchTier, identity.createdBy, identity.ownerOrgId, identity.siteId, identity.phoneCapable === true]
      );
      if (selectResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      // token_dispatch_tier + location_trust frozen, site stamped, in the same
      // atomic update: a pooled job (site_id NULL) records the claiming agent's
      // concrete site, and the job's trust is fixed at the moment it's claimed.
      const updateResult = await client.query(
        `UPDATE eval_jobs
         SET eval_agent_id = $1, status = 'running'::eval_job_status, started_at = NOW(), updated_at = NOW(),
             token_dispatch_tier = $3,
             site_id = COALESCE(site_id, $4),
             location_trust = $5
         WHERE id = $2
         RETURNING *`,
        [agentId, jobId, identity.dispatchTier, identity.siteId, identity.locationTrust]
      );
      await client.query('COMMIT');
      return snakeToCamel(updateResult.rows[0]) as EvalJob;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getClaimableJobsForToken(identity: {
    id: number; siteId: string | null; region: string | null; dispatchTier: string; createdBy: number; ownerOrgId: number | null; phoneCapable?: boolean;
  }): Promise<EvalJob[]> {
    // Mirrors permissions.isClaimable() bit for bit (targeted / pooled / legacy).
    // A NULL region/siteId (Unverified agent) never matches the pooled/legacy
    // arms — that's the zero-trust gate; SQL is otherwise unchanged.
    const result = await pool.query(
      `SELECT ej.* FROM eval_jobs ej
        WHERE ej.status = 'pending'::eval_job_status
          -- Phone-transport jobs require the phone capability (design §8).
          AND ( ej.transport = 'web'::transport OR $7::boolean = true )
          AND (
            ej.target_token_id = $1
            OR ( ej.target_token_id IS NULL AND ej.target_region IS NOT NULL AND ej.target_region = $2 AND (
                   ( ej.target_tier = 'private'::dispatch_tier AND ej.created_by = $5 )
                OR ( ej.target_tier = 'team'::dispatch_tier
                     AND $4 IN ('team', 'public')
                     -- R2 (§11): frozen creator org, not live membership (seam invariant).
                     AND $6::integer IS NOT NULL AND ej.creator_org_id = $6 )
                OR ( ej.target_tier = 'public'::dispatch_tier AND $4 = 'public'
                     AND (ej.config -> 'sessionInjection') IS NULL )
            ) )
            OR ( ej.target_token_id IS NULL AND ej.target_region IS NULL AND ej.site_id = $3 AND (
                   ej.created_by = $5
                   OR ( $4 = 'public' AND (ej.config -> 'sessionInjection') IS NULL )
            ) )
          )
        ORDER BY ej.priority DESC, ej.created_at ASC`,
      [identity.id, identity.region, identity.siteId, identity.dispatchTier, identity.createdBy, identity.ownerOrgId, identity.phoneCapable === true],
    );
    return result.rows.map((r) => snakeToCamel(r) as EvalJob);
  }

  // Release stale jobs where agent hasn't sent heartbeat
  async releaseStaleJobs(staleThresholdMinutes: number = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    // Find running jobs where agent last_seen_at is older than threshold
    // Cast string literals to eval_job_status enum type for PostgreSQL compatibility
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET
        status = CASE
          WHEN retry_count >= max_retries THEN 'failed'::eval_job_status
          ELSE 'pending'::eval_job_status
        END,
        retry_count = retry_count + 1,
        eval_agent_id = NULL,
        started_at = NULL,
        error = CASE
          WHEN retry_count >= max_retries THEN 'Agent timeout - max retries exceeded'
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE id IN (
        SELECT ej.id FROM eval_jobs ej
        INNER JOIN eval_agents ea ON ej.eval_agent_id = ea.id
        WHERE ej.status = 'running'::eval_job_status
        AND ea.last_seen_at < ${staleThreshold}
      )
    `);

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Hard job-level timeout: fail any job that has been "running" longer than
  // maxRunMinutes, regardless of agent heartbeat. Catches jobs whose agent zombied
  // or was superseded (its heartbeats stop updating last_seen_at, so the
  // heartbeat reaper never reclaims them) — otherwise they hang "running" forever.
  // Terminal (failed), so the user sees a clear result instead of an endless run.
  async failTimedOutRunningJobs(maxRunMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxRunMinutes * 60 * 1000);
    const message = `Exceeded maximum running time (${maxRunMinutes} min) — the agent stopped responding`;
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET status = 'failed'::eval_job_status,
          error = ${message},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE status = 'running'::eval_job_status
      AND started_at IS NOT NULL
      AND started_at < ${cutoff}
    `);
    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Fast-fail pending jobs whose site has NO online eval agent. "Online" = an
  // agent for that site heartbeated within onlineWithinMinutes. A job is failed
  // only once it has waited timeoutMinutes AND no such agent exists — so a brief
  // agent restart/redeploy (host reboot, vox-upgrade) doesn't trip it, but a
  // genuinely unstaffed site gives the user an actionable result in minutes
  // instead of hanging "pending" forever. Terminal (failed): retrying can't
  // summon an agent that isn't there. Job pickup is exact site-equality and an
  // agent registers under its token's site, so eval_agents.site_id = the job's
  // site_id is the correct "an agent serves this site" signal.
  //
  // Age from GREATEST(created_at, updated_at), NOT created_at alone: releaseStaleJobs
  // / releaseAgentRunningJobs requeue a job (status → pending, retry_count++) and set
  // updated_at = NOW() without touching created_at. Aging from created_at would fail a
  // freshly-requeued job on the spot — the exact single-agent-restart case this grace
  // window protects — nullifying the retry budget. updated_at is only ever bumped when
  // a row (re)enters pending or leaves it, so GREATEST = "last entered the queue".
  //
  // excludeTeamTier: while the organizations provider is unavailable, a team-tier
  // job cannot be authorized or claimed (its claim arm needs membership), so
  // failing it would turn a temporary outage into a permanent, user-visible job
  // failure. Callers pass `getOrganizations() === null` — absence only; the
  // claim path's team arm is plain SQL and keeps working through a *throwing*
  // provider, so a failure does not warrant holding the sweep back.
  // DELIBERATELY REQUIRED (no default): a second sweep caller — an admin "reap
  // now", another worker — that simply forgot the flag would silently reinstate
  // the §7 violation, and no test would discriminate. tsc makes the omission a
  // compile error, so every future caller has to decide.
  async failPendingJobsWithNoAgent(
    timeoutMinutes: number,
    onlineWithinMinutes: number,
    excludeTeamTier: boolean,
  ): Promise<number> {
    const timeoutCutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const onlineCutoff = new Date(Date.now() - onlineWithinMinutes * 60 * 1000);
    const prefix = "No eval agent available for region ";
    const suffix = ` (unclaimed for ${timeoutMinutes} min)`;
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET status = 'failed'::eval_job_status,
          error = ${prefix} || site_id || ${suffix},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE status = 'pending'::eval_job_status
      AND site_id IS NOT NULL
      AND target_region IS NULL
      AND GREATEST(created_at, updated_at) < ${timeoutCutoff}
      ${excludeTeamTier ? sql`AND target_tier IS DISTINCT FROM 'team'` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM eval_agents ea
        WHERE ea.site_id = eval_jobs.site_id
        AND ea.last_seen_at >= ${onlineCutoff}
      )
    `);
    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Backstop: fail any pending job that has waited longer than maxWaitMinutes,
  // regardless of agent availability. Catches pathological cases the no-agent
  // fast-fail misses (e.g. a region that always has an online agent which somehow
  // never claims the job). Terminal (failed). Ages from GREATEST(created_at,
  // updated_at) for the same requeue reason as failPendingJobsWithNoAgent above.
  // excludeTeamTier: see failPendingJobsWithNoAgent above — same reason, same
  // caller-supplied condition (organizations provider absent), and likewise
  // REQUIRED so a future sweep caller cannot omit it by accident.
  async failExpiredPendingJobs(maxWaitMinutes: number, excludeTeamTier: boolean): Promise<number> {
    const cutoff = new Date(Date.now() - maxWaitMinutes * 60 * 1000);
    const message = `Not claimed by any eval agent within ${maxWaitMinutes} min`;
    // Pooled backstop message (24h by default): render hours when the window is
    // an even number of hours ("within 24h") instead of the always-minutes form
    // ("within 1440 min"), and avoid the "eligible eligible agent" repeat when
    // target_tier is somehow null on a pooled row.
    const pooledWaitLabel = maxWaitMinutes % 60 === 0 ? `${maxWaitMinutes / 60}h` : `${maxWaitMinutes} min`;
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET status = 'failed'::eval_job_status,
          error = CASE
            WHEN target_region IS NOT NULL
              THEN 'No eligible ' || COALESCE(target_tier::text, 'matching') || ' agent in ' || target_region || ' claimed the job within ' || ${pooledWaitLabel}
            ELSE ${message}
          END,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE status = 'pending'::eval_job_status
      AND GREATEST(created_at, updated_at) < ${cutoff}
      ${excludeTeamTier ? sql`AND target_tier IS DISTINCT FROM 'team'` : sql``}
    `);
    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Recently-terminal targeted jobs (completed or failed) that may still hold an
  // unsettled shared dispatch. Read-only; the maintenance loop calls
  // marketplace.settle() on each (idempotent). Money stays in the plugin — this
  // only selects candidates by the opaque snapshot marker Core stashed at dispatch.
  async getReapableSharedJobs(sinceMinutes: number, graceMinutes: number, limit: number): Promise<EvalJob[]> {
    const now = Date.now();
    const windowStart = new Date(now - sinceMinutes * 60 * 1000);
    // Grace-period upper bound: exclude jobs that turned terminal too recently.
    // The complete route commits `status='completed'` in finalizeRunningJob BEFORE
    // it writes the evalResults row; a sweep landing in that sub-second window would
    // see hasResult=false and REFUND a job that produces a valid result an instant
    // later (the H1 artifact gate makes the refund terminal, so the complete route's
    // own settle then no-ops and the owner is never paid). Waiting graceMinutes puts
    // the result row well in the past before we settle here. Prompt settlement still
    // happens on the complete route itself; this sweep is only the catch-up path
    // (GitHub #90).
    //
    // Clock note: these bounds are app-clock (Date.now()). The money path — a
    // `completed` job via finalizeRunningJob — writes completed_at with app-clock
    // `new Date()` too, so the #90 race stays consistent. The bulk FAIL paths
    // (failTimedOutRunningJobs / failPendingJobsWithNoAgent / failExpiredPendingJobs)
    // write completed_at = DB-clock NOW(), so a `failed` row's grace bound can skew
    // by instance-vs-DB clock drift — harmless, since a failed job REFUNDS whether
    // swept a tick earlier or later. Switching to NOW() here would instead skew the
    // money path (app-clock write vs DB-clock read), so app-clock is the right choice.
    const graceCutoff = new Date(now - graceMinutes * 60 * 1000);
    return db.select().from(evalJobs)
      .where(and(
        // Both terminal outcomes carry an unsettled dispatch: a `failed` job
        // refunds, a `completed` job whose complete-route settle threw still needs
        // capturing. Widened from failed-only so a completed-but-unsettled job is
        // re-driven (captured) here rather than eventually released by the 26h
        // leak-reaper — which would refund valid completed work (review C1).
        inArray(evalJobs.status, ["completed", "failed"]),
        isNotNull(evalJobs.targetTokenId),
        gte(evalJobs.completedAt, windowStart),
        lte(evalJobs.completedAt, graceCutoff),
        sql`${evalJobs.snapshot} -> 'settlementContext' IS NOT NULL`,
      ))
      // Ascending (oldest-first): if more than `limit` targeted jobs terminate in
      // one window, drain the ones closest to aging out to the 26h leak-reaper
      // first. Descending dropped exactly those, letting valid completed work be
      // refunded by the leak-reaper instead of captured here (GitHub #90 / #7).
      // Secondary key on id breaks completed_at ties (ms precision → ties possible)
      // so the batch boundary is deterministic — an unlucky tie spanning `limit`
      // can't leave the same overflow row re-picked-and-truncated every tick.
      .orderBy(asc(evalJobs.completedAt), asc(evalJobs.id))
      .limit(limit);
  }

  // Release running jobs still assigned to an agent that just (re)registered.
  // A fresh registration means the previous process died mid-job, so those jobs
  // are orphaned — the reaper's heartbeat-staleness check never catches them
  // because the restarted agent's heartbeat is fresh. Re-queue (retry_count++)
  // or fail at max retries, mirroring releaseStaleJobs.
  async releaseAgentRunningJobs(agentId: number): Promise<number> {
    const result = await db.execute(sql`
      UPDATE eval_jobs
      SET
        status = CASE
          WHEN retry_count >= max_retries THEN 'failed'::eval_job_status
          ELSE 'pending'::eval_job_status
        END,
        retry_count = retry_count + 1,
        eval_agent_id = NULL,
        started_at = NULL,
        error = CASE
          WHEN retry_count >= max_retries THEN 'Agent restarted mid-job - max retries exceeded'
          ELSE NULL
        END,
        updated_at = NOW()
      WHERE status = 'running'::eval_job_status
      AND eval_agent_id = ${agentId}
    `);

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Get all jobs with optional filters
  async getEvalJobs(filters?: {
    status?: "pending" | "running" | "completed" | "failed";
    region?: string;
    evalflowId?: number;
    agentId?: number;
    ownerId?: number;
    hoursBack?: number;
    limit?: number;
    offset?: number;
  }): Promise<EvalJob[]> {
    const conditions = [];
    if (filters?.status) {
      conditions.push(eq(evalJobs.status, filters.status));
    }
    if (filters?.region) {
      // A claimed job carries a concrete site under the region (base-NN); a
      // pending pooled job carries only targetRegion. Match both so pending
      // pooled rows don't vanish under the filter.
      // Sites are strictly <base>-NN; a bare LIKE 'base-%' would also match a
      // longer dash-delimited baseId (na-us-seattle vs na-us-seattle-north).
      // Anchor the suffix to digits. The value is whitelist-validated against
      // region_locations baseIds ([a-z0-9-]) by the route, so it carries no
      // regex metacharacters.
      // Regex only — NO sort-order range bounds: sentinel tricks like
      // `<= 'base-\uFFFF'` are collation-dependent (glibc locales sort U+FFFF
      // before digits, silently dropping every claimed row; alpine's C
      // collation masks it locally). The regex is exact under all collations —
      // migration 0023 guarantees every site_id is <base>-NN — and also guards
      // the prefix-colliding-baseId case (na-us-seattle vs na-us-seattle-north).
      // target_region is stamped on every pooled row and never cleared at
      // claim, so the eq arm covers pooled rows (pending AND claimed) with an
      // indexable predicate; the regex arm remains only for site-pinned rows
      // (targeted + legacy), staying exact under all collations and immune to
      // prefix-colliding baseIds (na-us-seattle vs na-us-seattle-north).
      conditions.push(
        or(
          eq(evalJobs.targetRegion, filters.region),
          sql`${evalJobs.siteId} ~ ${"^" + filters.region + "-[0-9]+$"}`,
        )!,
      );
    }
    if (filters?.hoursBack) {
      const cutoff = new Date(Date.now() - filters.hoursBack * 60 * 60 * 1000);
      conditions.push(gte(evalJobs.createdAt, cutoff));
    }
    if (filters?.evalflowId) {
      conditions.push(eq(evalJobs.evalflowId, filters.evalflowId));
    }
    if (filters?.agentId) {
      conditions.push(eq(evalJobs.evalAgentId, filters.agentId));
    }
    // "Owner" = the job's creator (immutable), not the evalflow owner — so a user's
    // job history survives evalflow deletion and isn't dropped by a live join.
    if (filters?.ownerId) {
      conditions.push(eq(evalJobs.createdBy, filters.ownerId));
    }

    let query = db.select().from(evalJobs);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    query = query.orderBy(desc(evalJobs.createdAt)) as typeof query;

    if (filters?.limit) {
      query = query.limit(filters.limit) as typeof query;
    }
    if (filters?.offset) {
      query = query.offset(filters.offset) as typeof query;
    }

    return query;
  }

  // Cancel a pending job
  async cancelEvalJob(jobId: number): Promise<EvalJob | undefined> {
    const job = await this.getEvalJob(jobId);
    if (!job || job.status !== 'pending') {
      return undefined;
    }

    const result = await db.update(evalJobs)
      .set({
        status: "failed",
        error: "Cancelled by user",
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(and(eq(evalJobs.id, jobId), eq(evalJobs.status, "pending")))
      .returning();

    return result[0];
  }

  // Get jobs that are running but agent is offline
  async getStaleRunningJobs(staleThresholdMinutes: number = 5): Promise<EvalJob[]> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await db.execute(sql`
      SELECT ej.* FROM eval_jobs ej
      INNER JOIN eval_agents ea ON ej.eval_agent_id = ea.id
      WHERE ej.status = 'running'::eval_job_status
      AND ea.last_seen_at < ${staleThreshold}
    `);

    return (result as unknown as { rows: EvalJob[] }).rows || [];
  }

  // Mark offline agents
  async markOfflineAgents(staleThresholdMinutes: number = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await db.update(evalAgents)
      .set({ state: "offline", updatedAt: new Date() })
      .where(and(
        sql`${evalAgents.lastSeenAt} < ${staleThreshold}`,
        sql`${evalAgents.state} != 'offline'::eval_agent_state`
      ));

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Mark brokers offline after prolonged silence. Mirrors markOfflineAgents but
  // also treats a NULL lastSeenAt as stale, and keeps the row (never deletes).
  async markStaleBrokersOffline(staleThresholdMinutes: number = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await db.update(brokers)
      .set({ state: "offline", updatedAt: new Date() })
      .where(and(
        sql`(${brokers.lastSeenAt} IS NULL OR ${brokers.lastSeenAt} < ${staleThreshold})`,
        sql`${brokers.state} != 'offline'::broker_state`
      ));

    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Atomically finalize a RUNNING job (running → completed/failed) in a single
  // UPDATE. Only the first caller gets a row back; a concurrent duplicate
  // completion or an already-terminal job returns undefined — so exactly one
  // completion creates the result.
  async finalizeRunningJob(jobId: number, error?: string): Promise<EvalJob | undefined> {
    const result = await db.update(evalJobs)
      .set({
        status: error ? "failed" : "completed",
        completedAt: new Date(),
        error: error || null,
        updatedAt: new Date(),
      })
      .where(and(eq(evalJobs.id, jobId), eq(evalJobs.status, "running")))
      .returning();
    return result[0];
  }

  // Roll a just-finalized job back to running so a retry can re-attempt saving
  // its result (used when the result insert failed transiently after finalize).
  async resetJobToRunning(jobId: number): Promise<void> {
    await db.update(evalJobs)
      .set({ status: "running", completedAt: null, error: null, updatedAt: new Date() })
      .where(eq(evalJobs.id, jobId));
  }

  async completeEvalJob(jobId: number, error?: string): Promise<EvalJob | undefined> {
    const result = await db.update(evalJobs)
      .set({ 
        status: error ? "failed" : "completed", 
        completedAt: new Date(),
        error: error || null,
        updatedAt: new Date(),
      })
      .where(eq(evalJobs.id, jobId))
      .returning();
    return result[0];
  }

  async createEvalResult(result: InsertEvalResult): Promise<EvalResult> {
    const inserted = await db.insert(evalResults).values(result).returning();
    return inserted[0];
  }

  async getEvalResult(id: number): Promise<EvalResult | undefined> {
    const result = await db.select().from(evalResults).where(eq(evalResults.id, id));
    return result[0];
  }

  async getEvalResultsByJob(jobId: number): Promise<EvalResult[]> {
    return db.select().from(evalResults).where(eq(evalResults.evalJobId, jobId)).orderBy(desc(evalResults.createdAt));
  }

  // Artifact gate for shared-dispatch settlement (review H1): true iff the job
  // produced a real eval-result row. A `completed` job with no result row is a bare
  // self-report and must NOT capture the renter's escrow. Lean existence probe.
  async hasEvalResult(jobId: number): Promise<boolean> {
    const rows = await db.select({ id: evalResults.id }).from(evalResults)
      .where(eq(evalResults.evalJobId, jobId)).limit(1);
    return rows.length > 0;
  }

  async getEvalResultsByProvider(providerId: string): Promise<EvalResult[]> {
    return db.select().from(evalResults).where(eq(evalResults.providerId, providerId)).orderBy(desc(evalResults.createdAt));
  }

  /**
   * Batch response_rate lookup for a page of jobs — one query, no N+1. Used by
   * the jobs list to flag "Partial response" (responseRate < 1) without joining
   * full result rows. Jobs with no result are simply absent from the map.
   */
  async getResponseRatesByJobIds(jobIds: number[]): Promise<Map<number, number | null>> {
    const map = new Map<number, number | null>();
    if (jobIds.length === 0) return map;
    const rows = await db
      .select({ evalJobId: evalResults.evalJobId, responseRate: evalResults.responseRate })
      .from(evalResults)
      .where(inArray(evalResults.evalJobId, jobIds));
    // One result per job in practice; if several exist, first wins (order is
    // unspecified but the rate is per-job identical enough for a badge).
    for (const r of rows) {
      if (!map.has(r.evalJobId)) map.set(r.evalJobId, r.responseRate);
    }
    return map;
  }

  async getRecentEvalResults(limit: number = 50): Promise<EvalResult[]> {
    return db.select().from(evalResults).orderBy(desc(evalResults.createdAt)).limit(limit);
  }

  async getEvalResults(filters?: {
    ownerId?: number;
    evalflowId?: number;
    jobId?: number;
    limit?: number;
    offset?: number;
  }): Promise<EvalResult[]> {
    const conditions = [];

    if (filters?.jobId) {
      conditions.push(eq(evalResults.evalJobId, filters.jobId));
    }

    if (filters?.evalflowId || filters?.ownerId) {
      // Need to join with evalJobs and evalflows for these filters
      let query = db.select({
        id: evalResults.id,
        evalJobId: evalResults.evalJobId,
        providerId: evalResults.providerId,
        siteId: evalResults.siteId,
        responseLatencyMedian: evalResults.responseLatencyMedian,
        responseLatencySd: evalResults.responseLatencySd,
        responseLatencyP95: evalResults.responseLatencyP95,
        interruptLatencyMedian: evalResults.interruptLatencyMedian,
        interruptLatencySd: evalResults.interruptLatencySd,
        interruptLatencyP95: evalResults.interruptLatencyP95,
        responseRate: evalResults.responseRate,
        interruptRate: evalResults.interruptRate,
        falseInterruptRate: evalResults.falseInterruptRate,
        turnSuccessRate: evalResults.turnSuccessRate,
        callMetadata: evalResults.callMetadata,
        networkResilience: evalResults.networkResilience,
        naturalness: evalResults.naturalness,
        noiseReduction: evalResults.noiseReduction,
        rawData: evalResults.rawData,
        artifactStatus: evalResults.artifactStatus,
        artifactUrl: evalResults.artifactUrl,
        artifactFiles: evalResults.artifactFiles,
        createdAt: evalResults.createdAt,
      })
        .from(evalResults)
        .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id));

      if (filters.evalflowId) {
        conditions.push(eq(evalJobs.evalflowId, filters.evalflowId));
      }

      // Scope by the job's creator (immutable) — survives evalflow deletion and
      // matches the created_by model used for jobs/quota.
      if (filters.ownerId) {
        conditions.push(eq(evalJobs.createdBy, filters.ownerId));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return query
        .orderBy(desc(evalResults.createdAt))
        .limit(filters?.limit || 50)
        .offset(filters?.offset || 0);
    }

    // Simple query without joins
    let simpleQuery = db.select().from(evalResults);
    if (conditions.length > 0) {
      simpleQuery = simpleQuery.where(and(...conditions)) as typeof simpleQuery;
    }
    return simpleQuery
      .orderBy(desc(evalResults.createdAt))
      .limit(filters?.limit || 50)
      .offset(filters?.offset || 0);
  }

  // --- Metrics tiers (mainline / community / my-evals) -------------------
  // Each tier has its own WHERE conditions and join chain. Raw, daily-bucketed,
  // and span-probe queries all share these helpers so their filters can never
  // drift apart. See getXMetrics() for the span-based raw-vs-bucket policy.

  // Tiering reads the immutable per-job snapshot (see JobSnapshot) instead of the
  // live evalflows/eval_sets/users/agent-tokens. Consequences: a result keeps its
  // run-time tier even after its evalflow/eval-set is edited or deleted, and the
  // join chain collapses to just eval_results → eval_jobs.
  private regionScopeCondition(scope?: RegionQueryScope) {
    if (!scope) return undefined;
    if (scope.siteId) return eq(evalResults.siteId, scope.siteId);
    const parts: any[] = [];
    if (scope.baseIds && scope.baseIds.length > 0) {
      parts.push(or(...scope.baseIds.map((baseId) => sql<boolean>`${evalResults.siteId} LIKE ${baseId + "-%"}`)));
    }
    if (scope.unverified) parts.push(isNull(evalResults.siteId));
    if (scope.baseIds && scope.baseIds.length === 0 && !scope.unverified) return sql<boolean>`false`;
    if (parts.length === 0) return undefined;
    return parts.length === 1 ? parts[0] : or(...parts);
  }

  private mainlineConditions(hoursBack?: number, scope?: RegionQueryScope) {
    const snap = evalJobs.snapshot;
    const conditions = [
      eq(evalJobs.status, "completed"),
      sql`${snap}->'evalflow'->>'visibility' = 'public'`,
      // Compare as text ('true'/'false') so the text expression index is usable.
      sql`${snap}->'evalflow'->>'isMainline' = 'true'`,
      sql`${snap}->'evalSet'->>'visibility' = 'public'`,
      sql`${snap}->'evalSet'->>'isMainline' = 'true'`,
      eq(evalJobs.tokenDispatchTier, "public"),
      // Only principal/fellow creators' jobs qualify as mainline
      sql`${snap}->>'creatorPlan' IN ('principal', 'fellow')`,
    ];
    if (hoursBack) {
      conditions.push(gte(evalResults.createdAt, new Date(Date.now() - hoursBack * 60 * 60 * 1000)));
    }
    const regionCondition = this.regionScopeCondition(scope);
    if (regionCondition) conditions.push(regionCondition);
    return conditions;
  }

  private communityConditions(hoursBack?: number, scope?: RegionQueryScope) {
    const snap = evalJobs.snapshot;
    const conditions = [
      eq(evalJobs.status, "completed"),
      sql`${snap}->'evalflow'->>'visibility' = 'public'`,
      sql`${snap}->'evalSet'->>'visibility' = 'public'`,
      // Agent gate (tier as restriction): only public/shared agents feed a public
      // board. private/team agents appear on no public leaderboard.
      inArray(evalJobs.tokenDispatchTier, ["public", "shared"]),
      // Exclude fully mainline results (all 4 inputs true → mainline).
      // Text comparison (matches the expression index; NULL/'false' → not mainline).
      or(
        sql`${snap}->'evalflow'->>'isMainline' IS DISTINCT FROM 'true'`,
        sql`${snap}->'evalSet'->>'isMainline' IS DISTINCT FROM 'true'`,
        sql`${evalJobs.tokenDispatchTier} IS DISTINCT FROM 'public'`,
        sql`${snap}->>'creatorPlan' IS NULL OR ${snap}->>'creatorPlan' NOT IN ('principal', 'fellow')`,
      ),
      // Zero-trust gate: only region-trusted agents feed the public community
      // board; public agents are configured (admin-trusted); NULL grandfathers
      // pre-feature rows (history never reclassifies).
      or(
        eq(evalJobs.tokenDispatchTier, "public"),
        sql`${evalJobs.locationTrust} IS NULL`,
        inArray(evalJobs.locationTrust, ["trusted", "datacenter"]),
      ),
    ];
    if (hoursBack) {
      conditions.push(gte(evalResults.createdAt, new Date(Date.now() - hoursBack * 60 * 60 * 1000)));
    }
    const regionCondition = this.regionScopeCondition(scope);
    if (regionCondition) conditions.push(regionCondition);
    return conditions;
  }

  private myEvalConditions(userId: number, hoursBack?: number, scope?: RegionQueryScope) {
    const snap = evalJobs.snapshot;
    const conditions = [
      eq(evalJobs.status, "completed"),
      or(
        sql`${snap}->'evalflow'->>'visibility' = 'private' AND (${snap}->'evalflow'->>'ownerId')::int = ${userId}`,
        sql`${snap}->'evalSet'->>'visibility' = 'private' AND (${snap}->'evalSet'->>'ownerId')::int = ${userId}`,
        // Own job on own private/team agent. Without this arm such a result is
        // ORPHANED: the two public boards exclude private/team agents by design
        // ("tier as restriction"), and the content arms above only fire when the
        // evalflow or eval set is private — so running a PUBLIC evalflow on your
        // OWN private agent produced a result visible nowhere. Fenced by
        // created_by, so this shows a user only their own dispatches (a team
        // agent serving an org-mate's job stays in that dispatcher's My Evals,
        // not the agent owner's).
        and(
          inArray(evalJobs.tokenDispatchTier, ["private", "team"]),
          eq(evalJobs.createdBy, userId),
        ),
      ),
    ];
    if (hoursBack) {
      conditions.push(gte(evalResults.createdAt, new Date(Date.now() - hoursBack * 60 * 60 * 1000)));
    }
    const regionCondition = this.regionScopeCondition(scope);
    if (regionCondition) conditions.push(regionCondition);
    return conditions;
  }

  // All three tiers now share one join (eval_results → eval_jobs); the tier is
  // determined entirely by the snapshot-based conditions above.
  private joinTier(q: any): any {
    return q.innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id));
  }
  private joinMainline(q: any): any { return this.joinTier(q); }
  private joinCommunity(q: any): any { return this.joinTier(q); }
  private joinMyEvals(q: any): any { return this.joinTier(q); }

  private tierConditions(tier: MetricTier, hoursBack?: number, userId?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web") {
    const conditions = tier === "mainline" ? this.mainlineConditions(hoursBack, scope)
      : tier === "community" ? this.communityConditions(hoursBack, scope)
      : this.myEvalConditions(userId!, hoursBack, scope);
    // Transport is a hard partition, never mixed (design 2026-09-21 §11): every
    // tier view is scoped to exactly one transport; default web.
    conditions.push(eq(evalJobs.transport, transport));
    return conditions;
  }
  private applyTierJoins(tier: MetricTier, q: any): any {
    return tier === "mainline" ? this.joinMainline(q)
      : tier === "community" ? this.joinCommunity(q)
      : this.joinMyEvals(q);
  }

  // Earliest createdAt for a tier (null if no rows) → used to size "all time".
  private async tierSpanDays(tier: MetricTier, userId?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<number | null> {
    const base = db.select({ minAt: sql<string | null>`min(${evalResults.createdAt})` }).from(evalResults);
    const rows = await this.applyTierJoins(tier, base).where(and(...this.tierConditions(tier, undefined, userId, scope, transport)));
    const minAt = rows[0]?.minAt;
    if (!minAt) return null;
    return (Date.now() - new Date(minAt).getTime()) / (24 * 60 * 60 * 1000);
  }

  // One averaged point per (day, provider, site). Same shape formatMetricsResults
  // consumes; SD/P95/secondary metrics are averages-of-aggregates (trend overview).
  private async tierBucketedDaily(tier: MetricTier, hoursBack?: number, userId?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<MetricSourceRow[]> {
    const day = sql`date_trunc('day', ${evalResults.createdAt})`;
    const base = db.select({
      id: sql<number>`min(${evalResults.id})::int`,
      providerId: evalResults.providerId,
      siteId: evalResults.siteId,
      responseLatencyMedian: sql<number>`round(avg(${evalResults.responseLatencyMedian}))::int`,
      responseLatencySd: sql<number>`avg(${evalResults.responseLatencySd})::real`,
      responseLatencyP95: sql<number>`round(avg(${evalResults.responseLatencyP95}))::int`,
      interruptLatencyMedian: sql<number>`round(avg(${evalResults.interruptLatencyMedian}))::int`,
      interruptLatencySd: sql<number>`avg(${evalResults.interruptLatencySd})::real`,
      interruptLatencyP95: sql<number>`round(avg(${evalResults.interruptLatencyP95}))::int`,
      turnSuccessRate: sql<number | null>`avg(${evalResults.turnSuccessRate})::real`,
      networkResilience: sql<number | null>`round(avg(${evalResults.networkResilience}))::int`,
      naturalness: sql<number | null>`avg(${evalResults.naturalness})::real`,
      noiseReduction: sql<number | null>`round(avg(${evalResults.noiseReduction}))::int`,
      createdAt: sql<Date>`${day}`,
    }).from(evalResults);
    const rows = await this.applyTierJoins(tier, base)
      .where(and(...this.tierConditions(tier, hoursBack, userId, scope, transport)))
      .groupBy(day, evalResults.providerId, evalResults.siteId)
      .orderBy(day);
    // The query is partitioned to one transport, so it's a constant per row.
    return (rows as any[]).map((r) => ({ ...r, transport })) as MetricSourceRow[];
  }

  // Applies the windowing policy (see the module-level comment). "All time"
  // (no hoursBack) is bounded to the retention cap and its raw-vs-bucket mode is
  // sized from the actual data span, so a young deployment's "all" stays raw.
  private async tierMetrics(tier: MetricTier, hoursBack?: number, userId?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<MetricSourceRow[]> {
    let effectiveHoursBack = hoursBack;
    let spanDays: number;
    if (hoursBack != null) {
      spanDays = hoursBack / 24;
    } else {
      // "all time": clamp the window to the 3-year retention cap, and decide
      // raw-vs-bucket from how much history actually exists (also clamped).
      effectiveHoursBack = METRICS_ALL_MAX_DAYS * 24;
      const actualSpan = (await this.tierSpanDays(tier, userId, scope, transport)) ?? 0;
      spanDays = Math.min(actualSpan, METRICS_ALL_MAX_DAYS);
    }

    if (resolveMetricsMode(spanDays) === "bucketDay") {
      return this.tierBucketedDaily(tier, effectiveHoursBack, userId, scope, transport);
    }
    const rows = await this.applyTierJoins(tier, db.select().from(evalResults))
      .where(and(...this.tierConditions(tier, effectiveHoursBack, userId, scope, transport)))
      .orderBy(desc(evalResults.createdAt))
      .limit(METRICS_RAW_ROW_CEILING);
    // evalJobs is already inner-joined (joinTier) for tiering, so its snapshot +
    // evalflowId ride along — attach the evalflow identity for the hover tooltip.
    return rows.map((r: any) => ({
      ...r.eval_results,
      evalflowId: r.eval_jobs?.evalflowId ?? null,
      evalflowName: (r.eval_jobs?.snapshot as JobSnapshot | null)?.evalflow?.name ?? null,
      transport,
    })) as MetricSourceRow[];
  }

  // Public metrics entry points used by the realtime dashboard. They own the
  // raw-vs-bucket decision and the row ceiling — callers pass only the window.
  getMainlineMetrics(hoursBack?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<MetricSourceRow[]> {
    return this.tierMetrics("mainline", hoursBack, undefined, scope, transport);
  }
  getCommunityMetrics(hoursBack?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<MetricSourceRow[]> {
    return this.tierMetrics("community", hoursBack, undefined, scope, transport);
  }
  getMyEvalMetrics(userId: number, hoursBack?: number, scope?: RegionQueryScope, transport: "web" | "phone" = "web"): Promise<MetricSourceRow[]> {
    return this.tierMetrics("myEvals", hoursBack, userId, scope, transport);
  }

  // Available regions for a tier's picker: same tier conditions as the metrics
  // queries above, NO scope (the picker needs to show every region the tier
  // could be narrowed to, not just the currently-selected one). Site IDs are
  // stripped to their base ("<base>-NN" -> "<base>") and deduped/counted;
  // a NULL siteId (unverified/self-hosted agent) is reported separately via
  // hasUnverified rather than mixed into baseIds.
  async getAvailableRegions(tier: MetricTier, hoursBack?: number, userId?: number): Promise<{ baseIds: string[]; hasUnverified: boolean }> {
    const conditions = this.tierConditions(tier, hoursBack, userId);
    const rows = await this.applyTierJoins(tier, db
      .select({
        baseId: sql<string | null>`regexp_replace(${evalResults.siteId}, '-\\d+$', '')`,
      })
      .from(evalResults))
      .where(and(...conditions))
      .groupBy(sql`regexp_replace(${evalResults.siteId}, '-\\d+$', '')`);
    return {
      baseIds: rows.filter((r: { baseId: string | null }) => r.baseId != null).map((r: { baseId: string | null }) => r.baseId as string).sort(),
      hasUnverified: rows.some((r: { baseId: string | null }) => r.baseId == null),
    };
  }

  // Raw, limit-controlled tier queries — kept for the leaderboard / API v1
  // callers that request a fixed count and don't need the span policy.
  async getMainlineEvalResults(limit: number = 50, hoursBack?: number, scope?: RegionQueryScope): Promise<EvalResult[]> {
    return this.joinMainline(db.select().from(evalResults))
      .where(and(...this.mainlineConditions(hoursBack, scope)))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then((rows: any[]) => rows.map(r => r.eval_results));
  }

  async getCommunityEvalResults(limit: number = 50, hoursBack?: number): Promise<EvalResult[]> {
    return this.joinCommunity(db.select().from(evalResults))
      .where(and(...this.communityConditions(hoursBack)))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then((rows: any[]) => rows.map(r => r.eval_results));
  }

  async getMyEvalResults(userId: number, limit: number = 50, hoursBack?: number): Promise<EvalResult[]> {
    return this.joinMyEvals(db.select().from(evalResults))
      .where(and(...this.myEvalConditions(userId, hoursBack)))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit)
      .then((rows: any[]) => rows.map(r => r.eval_results));
  }

  async createApiKey(apiKey: InsertApiKey): Promise<ApiKey> {
    const result = await db.insert(apiKeys).values({
      ...apiKey,
      lastOperation: "create",
      lastOperationAt: new Date(),
      lastOperationBy: apiKey.createdBy,
    }).returning();
    return result[0];
  }

  async getApiKey(id: number): Promise<ApiKey | undefined> {
    const result = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    return result[0];
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    const result = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    return result[0];
  }

  // Excludes soft-deleted keys — deleted rows are kept for auditing but never listed.
  async getApiKeysByUser(userId: number): Promise<ApiKey[]> {
    return db.select().from(apiKeys)
      .where(and(eq(apiKeys.createdBy, userId), eq(apiKeys.isDeleted, false)))
      .orderBy(desc(apiKeys.createdAt));
  }

  async revokeApiKey(id: number, operatorId?: number): Promise<void> {
    await db.update(apiKeys).set({
      isRevoked: true,
      revokedAt: new Date(),
      lastOperation: "revoke",
      lastOperationAt: new Date(),
      lastOperationBy: operatorId ?? null,
    }).where(eq(apiKeys.id, id));
  }

  async incrementApiKeyUsage(id: number): Promise<void> {
    await db.update(apiKeys).set({
      usageCount: sql`${apiKeys.usageCount} + 1`,
      lastUsedAt: new Date()
    }).where(eq(apiKeys.id, id));
  }

  // Soft-delete: mark deleted (row retained for auditing), never DELETE.
  async deleteApiKey(id: number, operatorId?: number): Promise<void> {
    await db.update(apiKeys).set({
      isDeleted: true,
      deletedAt: new Date(),
      lastOperation: "delete",
      lastOperationAt: new Date(),
      lastOperationBy: operatorId ?? null,
    }).where(eq(apiKeys.id, id));
  }

  async getPricingConfig(id: number): Promise<PricingConfig | undefined> {
    const result = await db.select().from(pricingConfig).where(eq(pricingConfig.id, id));
    return result[0];
  }

  async getAllPricingConfig(): Promise<PricingConfig[]> {
    return db.select().from(pricingConfig).where(eq(pricingConfig.isActive, true)).orderBy(pricingConfig.minSeats);
  }

  async setPricingConfig(config: InsertPricingConfig): Promise<PricingConfig> {
    const inserted = await db.insert(pricingConfig).values(config).returning();
    return inserted[0];
  }

  async updatePricingConfig(id: number, data: Partial<PricingConfig>): Promise<PricingConfig | undefined> {
    const result = await db.update(pricingConfig).set({ ...data, updatedAt: new Date() }).where(eq(pricingConfig.id, id)).returning();
    return result[0];
  }

  async createPaymentMethod(method: InsertPaymentMethod): Promise<PaymentMethod> {
    const result = await db.insert(paymentMethods).values(method).returning();
    return result[0];
  }

  async getPaymentMethod(id: number): Promise<PaymentMethod | undefined> {
    const result = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
    return result[0];
  }

  async getPaymentMethodsByUser(userId: number): Promise<PaymentMethod[]> {
    return db.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(desc(paymentMethods.createdAt));
  }

  async getPaymentMethodsByOrganization(organizationId: number): Promise<PaymentMethod[]> {
    return db.select().from(paymentMethods).where(eq(paymentMethods.organizationId, organizationId)).orderBy(desc(paymentMethods.createdAt));
  }

  async updatePaymentMethod(id: number, data: Partial<PaymentMethod>): Promise<PaymentMethod | undefined> {
    const result = await db.update(paymentMethods).set({ ...data, updatedAt: new Date() }).where(eq(paymentMethods.id, id)).returning();
    return result[0];
  }

  async deletePaymentMethod(id: number): Promise<void> {
    await db.delete(paymentMethods).where(eq(paymentMethods.id, id));
  }

  async createPaymentHistory(history: InsertPaymentHistory): Promise<PaymentHistory> {
    const result = await db.insert(paymentHistories).values(history).returning();
    return result[0];
  }

  async getPaymentHistoriesByUser(userId: number): Promise<PaymentHistory[]> {
    return db.select().from(paymentHistories).where(eq(paymentHistories.userId, userId)).orderBy(desc(paymentHistories.createdAt));
  }

  async getPaymentHistoriesByOrganization(organizationId: number): Promise<PaymentHistory[]> {
    return db.select().from(paymentHistories).where(eq(paymentHistories.organizationId, organizationId)).orderBy(desc(paymentHistories.createdAt));
  }

  async getPaymentHistoryByStripeId(stripePaymentIntentId: string): Promise<PaymentHistory | undefined> {
    const result = await db.select().from(paymentHistories).where(eq(paymentHistories.stripePaymentIntentId, stripePaymentIntentId));
    return result[0];
  }

  async updatePaymentHistoryStatus(id: number, status: string): Promise<PaymentHistory | undefined> {
    const result = await db.update(paymentHistories).set({ status }).where(eq(paymentHistories.id, id)).returning();
    return result[0];
  }

  async createOrganizationSeat(seat: InsertOrganizationSeat): Promise<OrganizationSeat> {
    const result = await db.insert(organizationSeats).values(seat).returning();
    return result[0];
  }

  async getOrganizationSeat(organizationId: number): Promise<OrganizationSeat | undefined> {
    const result = await db.select().from(organizationSeats).where(eq(organizationSeats.organizationId, organizationId));
    return result[0];
  }

  async updateOrganizationSeat(organizationId: number, data: Partial<OrganizationSeat>): Promise<OrganizationSeat | undefined> {
    const result = await db.update(organizationSeats).set({ ...data, updatedAt: new Date() }).where(eq(organizationSeats.organizationId, organizationId)).returning();
    return result[0];
  }

  async createActivationToken(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
    await db.insert(activationTokens).values({ userId, tokenHash, expiresAt });
  }

  async getActivationTokenByHash(tokenHash: string): Promise<{ userId: number; expiresAt: Date; usedAt: Date | null } | undefined> {
    const result = await db.select().from(activationTokens).where(eq(activationTokens.tokenHash, tokenHash));
    if (result[0]) {
      return { userId: result[0].userId, expiresAt: result[0].expiresAt, usedAt: result[0].usedAt };
    }
    return undefined;
  }

  async markActivationTokenUsed(tokenHash: string): Promise<void> {
    await db.update(activationTokens).set({ usedAt: new Date() }).where(eq(activationTokens.tokenHash, tokenHash));
  }

  async createInviteToken(email: string, plan: "basic" | "premium" | "principal" | "fellow", isAdmin: boolean, tokenHash: string, createdBy: number | null, expiresAt: Date, organizationId?: number): Promise<void> {
    await db.insert(inviteTokens).values({ 
      email, 
      plan, 
      isAdmin, 
      tokenHash, 
      createdBy, 
      expiresAt,
      organizationId,
    });
  }

  async getInviteTokenByHash(tokenHash: string): Promise<{ email: string; plan: string; isAdmin: boolean; expiresAt: Date; usedAt: Date | null; organizationId: number | null } | undefined> {
    const result = await db.select().from(inviteTokens).where(eq(inviteTokens.tokenHash, tokenHash));
    if (result[0]) {
      return { 
        email: result[0].email, 
        plan: result[0].plan, 
        isAdmin: result[0].isAdmin, 
        expiresAt: result[0].expiresAt,
        usedAt: result[0].usedAt,
        organizationId: result[0].organizationId,
      };
    }
    return undefined;
  }

  async markInviteTokenUsed(tokenHash: string): Promise<void> {
    await db.update(inviteTokens).set({ usedAt: new Date() }).where(eq(inviteTokens.tokenHash, tokenHash));
  }

  async getConfig(key: string): Promise<SystemConfig | undefined> {
    const result = await db.select().from(systemConfig).where(eq(systemConfig.key, key));
    return result[0];
  }

  async getAllConfig(): Promise<SystemConfig[]> {
    return db.select().from(systemConfig);
  }

  async setConfig(config: InsertSystemConfig): Promise<SystemConfig> {
    const existing = await this.getConfig(config.key);
    if (existing) {
      const updated = await db.update(systemConfig).set({ value: config.value }).where(eq(systemConfig.key, config.key)).returning();
      return updated[0];
    }
    const inserted = await db.insert(systemConfig).values(config).returning();
    return inserted[0];
  }

  async deleteConfig(key: string): Promise<void> {
    await db.delete(systemConfig).where(eq(systemConfig.key, key));
  }

  async createFundReturnRequest(request: InsertFundReturnRequest): Promise<FundReturnRequest> {
    const result = await db.insert(fundReturnRequests).values(request).returning();
    return result[0];
  }

  async getFundReturnRequest(id: number): Promise<FundReturnRequest | undefined> {
    const result = await db.select().from(fundReturnRequests).where(eq(fundReturnRequests.id, id));
    return result[0];
  }

  async getPendingFundReturnRequests(): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).where(eq(fundReturnRequests.status, "pending")).orderBy(desc(fundReturnRequests.createdAt));
  }

  async getFundReturnRequestsByUser(userId: number): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).where(eq(fundReturnRequests.userId, userId)).orderBy(desc(fundReturnRequests.createdAt));
  }

  async reviewFundReturnRequest(id: number, reviewedBy: number, status: "approved" | "rejected"): Promise<FundReturnRequest | undefined> {
    const result = await db.update(fundReturnRequests)
      .set({ status, reviewedBy, reviewedAt: new Date() })
      .where(eq(fundReturnRequests.id, id))
      .returning();
    return result[0];
  }

  async getDefaultPaymentMethod(organizationId: number): Promise<PaymentMethod | undefined> {
    const result = await db.select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.organizationId, organizationId), eq(paymentMethods.isDefault, true)));
    return result[0];
  }

  async setDefaultPaymentMethod(organizationId: number, paymentMethodId: number): Promise<void> {
    // Clear current default
    await db.update(paymentMethods)
      .set({ isDefault: false })
      .where(eq(paymentMethods.organizationId, organizationId));
    // Set new default
    await db.update(paymentMethods)
      .set({ isDefault: true })
      .where(eq(paymentMethods.id, paymentMethodId));
  }

  async getAllFundReturnRequests(): Promise<FundReturnRequest[]> {
    return db.select().from(fundReturnRequests).orderBy(desc(fundReturnRequests.createdAt));
  }

  // ==================== EVAL SCHEDULES ====================

  async createEvalSchedule(schedule: InsertEvalSchedule): Promise<EvalSchedule> {
    const result = await db.insert(evalSchedules).values(schedule).returning();
    return result[0];
  }

  async getEvalSchedule(id: number): Promise<EvalSchedule | undefined> {
    const result = await db.select().from(evalSchedules).where(eq(evalSchedules.id, id));
    return result[0];
  }

  async getEvalSchedulesByUser(userId: number): Promise<EvalSchedule[]> {
    return db.select().from(evalSchedules).where(eq(evalSchedules.createdBy, userId)).orderBy(desc(evalSchedules.createdAt));
  }

  async getEvalSchedulesByEvalflow(evalflowId: number): Promise<EvalSchedule[]> {
    return db.select().from(evalSchedules).where(eq(evalSchedules.evalflowId, evalflowId)).orderBy(desc(evalSchedules.createdAt));
  }

  async updateEvalSchedule(id: number, data: Partial<EvalSchedule>): Promise<EvalSchedule | undefined> {
    const result = await db.update(evalSchedules).set({ ...data, updatedAt: new Date() }).where(eq(evalSchedules.id, id)).returning();
    return result[0];
  }

  async deleteEvalSchedule(id: number): Promise<void> {
    await db.delete(evalSchedules).where(eq(evalSchedules.id, id));
  }

  // Count "active" schedules on an evalflow: enabled and not expired. Used to block
  // deletion of an evalflow that still has a live schedule.
  async countActiveSchedulesForEvalflow(evalflowId: number): Promise<number> {
    const now = new Date();
    const rows = await db.select({ count: sql<number>`count(*)::int` })
      .from(evalSchedules)
      .where(and(
        eq(evalSchedules.evalflowId, evalflowId),
        eq(evalSchedules.isEnabled, true),
        sql`(${evalSchedules.expiresAt} IS NULL OR ${evalSchedules.expiresAt} > ${now})`,
      ));
    return rows[0]?.count ?? 0;
  }

  // Get schedules that are due to run (isEnabled=true, nextRunAt <= now)
  async getDueSchedules(): Promise<EvalSchedule[]> {
    const now = new Date();
    return db.select()
      .from(evalSchedules)
      .where(
        and(
          eq(evalSchedules.isEnabled, true),
          sql`${evalSchedules.nextRunAt} <= ${now}`,
          // Skip expired schedules in SQL so they aren't re-read every tick.
          sql`(${evalSchedules.expiresAt} IS NULL OR ${evalSchedules.expiresAt} > ${now})`
        )
      )
      .orderBy(evalSchedules.nextRunAt);
  }

  // Update schedule after a job is created from it
  async markScheduleRun(scheduleId: number, nextRunAt: Date | null): Promise<EvalSchedule | undefined> {
    const result = await db.update(evalSchedules)
      .set({
        lastRunAt: new Date(),
        runCount: sql`${evalSchedules.runCount} + 1`,
        nextRunAt: nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(evalSchedules.id, scheduleId))
      .returning();
    return result[0];
  }

  // Disable schedule (e.g., when maxRuns reached or one-time completed)
  async disableSchedule(scheduleId: number): Promise<void> {
    await db.update(evalSchedules)
      .set({ isEnabled: false, nextRunAt: null, updatedAt: new Date() })
      .where(eq(evalSchedules.id, scheduleId));
  }

  // Get all enabled schedules for a user
  async getActiveSchedulesByUser(userId: number): Promise<EvalSchedule[]> {
    return db.select()
      .from(evalSchedules)
      .where(and(eq(evalSchedules.createdBy, userId), eq(evalSchedules.isEnabled, true)))
      .orderBy(evalSchedules.nextRunAt);
  }

  // Get schedules with their evalflow info (for listing)
  private buildScheduleQuery() {
    return {
      id: evalSchedules.id,
      name: evalSchedules.name,
      evalflowId: evalSchedules.evalflowId,
      evalSetId: evalSchedules.evalSetId,
      region: evalSchedules.region,
      targetTier: evalSchedules.targetTier,
      scheduleType: evalSchedules.scheduleType,
      cronExpression: evalSchedules.cronExpression,
      timezone: evalSchedules.timezone,
      isEnabled: evalSchedules.isEnabled,
      nextRunAt: evalSchedules.nextRunAt,
      lastRunAt: evalSchedules.lastRunAt,
      expiresAt: evalSchedules.expiresAt,
      runCount: evalSchedules.runCount,
      maxRuns: evalSchedules.maxRuns,
      createdBy: evalSchedules.createdBy,
      organizationId: evalSchedules.organizationId,
      createdAt: evalSchedules.createdAt,
      updatedAt: evalSchedules.updatedAt,
      // Left-joined: a schedule whose evalflow was deleted still lists (with a
      // placeholder) so users can find and remove the orphan.
      evalflowName: sql<string>`coalesce(${evalflows.name}, '(deleted evalflow)')`,
      evalflowOwnerId: evalflows.ownerId,
      evalflowOrganizationId: evalflows.organizationId,
      creatorName: users.username,
    };
  }

  // Returns the user's own schedules plus schedules on their organization's
  // evalflows (so an org manager can see/Extend them — actions are gated per row
  // by the route's canExtend/canManage flags).
  async getEvalSchedulesWithEvalflow(userId: number, organizationId?: number | null): Promise<(EvalSchedule & { evalflowName: string; evalflowOwnerId: number | null; evalflowOrganizationId: number | null; creatorName: string })[]> {
    const scope = organizationId != null
      ? or(eq(evalSchedules.createdBy, userId), eq(evalflows.organizationId, organizationId))
      : eq(evalSchedules.createdBy, userId);
    return db.select(this.buildScheduleQuery())
      .from(evalSchedules)
      .leftJoin(evalflows, eq(evalSchedules.evalflowId, evalflows.id))
      .innerJoin(users, eq(evalSchedules.createdBy, users.id))
      .where(scope)
      .orderBy(desc(evalSchedules.createdAt));
  }

  async getAllEvalSchedulesWithEvalflow(): Promise<(EvalSchedule & { evalflowName: string; evalflowOwnerId: number | null; evalflowOrganizationId: number | null; creatorName: string })[]> {
    return db.select(this.buildScheduleQuery())
      .from(evalSchedules)
      .leftJoin(evalflows, eq(evalSchedules.evalflowId, evalflows.id))
      .innerJoin(users, eq(evalSchedules.createdBy, users.id))
      .orderBy(desc(evalSchedules.createdAt));
  }

  // ==================== SECRETS ====================

  async createOrUpdateSecret(
    userId: number,
    name: string,
    encryptedValue: string,
    opts?: { brokerType?: string | null; isTestAccount?: boolean }
  ): Promise<Secret> {
    const existing = await db.select().from(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.name, name)));
    if (existing[0]) {
      const updates: Partial<typeof secrets.$inferInsert> = { encryptedValue, updatedAt: new Date() };
      if (opts?.brokerType !== undefined) updates.brokerType = opts.brokerType;
      if (opts?.isTestAccount !== undefined) updates.isTestAccount = opts.isTestAccount;
      const result = await db.update(secrets)
        .set(updates)
        .where(eq(secrets.id, existing[0].id))
        .returning();
      return result[0];
    }
    const result = await db.insert(secrets).values({
      userId,
      name,
      encryptedValue,
      brokerType: opts?.brokerType ?? null,
      ...(opts?.isTestAccount !== undefined ? { isTestAccount: opts.isTestAccount } : {}),
    }).returning();
    return result[0];
  }

  async getSecretsByUserId(userId: number): Promise<Secret[]> {
    return db.select().from(secrets).where(eq(secrets.userId, userId)).orderBy(desc(secrets.createdAt));
  }

  async deleteSecret(userId: number, name: string): Promise<boolean> {
    const result = await db.delete(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.name, name)))
      .returning();
    return result.length > 0;
  }

  async getSecretsForJob(jobId: number): Promise<Secret[]> {
    // Find the evalflow owner for this job, then return their secrets
    const job = await this.getEvalJob(jobId);
    if (!job) { console.log(`[Secrets] getSecretsForJob: job ${jobId} not found`); return []; }
    if (job.evalflowId == null) { console.log(`[Secrets] getSecretsForJob: job ${jobId} has no evalflow (deleted)`); return []; }
    const evalflow = await this.getEvalflow(job.evalflowId);
    if (!evalflow) { console.log(`[Secrets] getSecretsForJob: evalflow ${job.evalflowId} not found`); return []; }
    console.log(`[Secrets] getSecretsForJob: job ${jobId} → evalflow ${evalflow.id} → owner ${evalflow.ownerId}`);
    // Structural withhold: brokered rows (broker_type != null) are Core-only. They
    // feed the session broker's mint and must never reach an eval agent, any tier.
    const all = await this.getSecretsByUserId(evalflow.ownerId);
    return all.filter((s) => s.brokerType == null);
  }

  // ==================== CLASH AGENT PROFILES ====================

  async getClashAgentProfile(id: number): Promise<ClashAgentProfile | undefined> {
    const result = await db.select().from(clashAgentProfiles).where(eq(clashAgentProfiles.id, id));
    return result[0];
  }

  async getClashAgentProfilesByOwner(ownerId: number): Promise<ClashAgentProfile[]> {
    return db.select().from(clashAgentProfiles)
      .where(eq(clashAgentProfiles.ownerId, ownerId))
      .orderBy(desc(clashAgentProfiles.createdAt));
  }

  async getPublicClashAgentProfiles(): Promise<ClashAgentProfile[]> {
    return db.select().from(clashAgentProfiles)
      .where(eq(clashAgentProfiles.visibility, "public"))
      .orderBy(desc(clashAgentProfiles.createdAt));
  }

  async createClashAgentProfile(data: InsertClashAgentProfile): Promise<ClashAgentProfile> {
    const result = await db.insert(clashAgentProfiles).values(data).returning();
    return result[0];
  }

  async updateClashAgentProfile(id: number, data: Partial<InsertClashAgentProfile>): Promise<ClashAgentProfile | undefined> {
    const result = await db.update(clashAgentProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clashAgentProfiles.id, id))
      .returning();
    return result[0];
  }

  async deleteClashAgentProfile(id: number): Promise<boolean> {
    const result = await db.delete(clashAgentProfiles).where(eq(clashAgentProfiles.id, id)).returning();
    return result.length > 0;
  }

  // ==================== CLASH EVENTS ====================

  async getClashEvent(id: number): Promise<ClashEvent | undefined> {
    const result = await db.select().from(clashEvents).where(eq(clashEvents.id, id));
    return result[0];
  }

  async getClashEventsByUser(userId: number): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(eq(clashEvents.createdBy, userId))
      .orderBy(desc(clashEvents.createdAt));
  }

  async getClashEventsByStatus(status: string): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(eq(clashEvents.status, status as any))
      .orderBy(desc(clashEvents.createdAt));
  }

  async getClashEventFeed(): Promise<ClashEvent[]> {
    return db.select().from(clashEvents)
      .where(or(
        eq(clashEvents.status, "live"),
        eq(clashEvents.status, "upcoming"),
        eq(clashEvents.status, "completed"),
      ))
      .orderBy(desc(clashEvents.createdAt))
      .limit(50);
  }

  async createClashEvent(data: InsertClashEvent): Promise<ClashEvent> {
    const result = await db.insert(clashEvents).values(data).returning();
    return result[0];
  }

  async updateClashEvent(id: number, data: Partial<ClashEvent>): Promise<ClashEvent | undefined> {
    const result = await db.update(clashEvents).set(data).where(eq(clashEvents.id, id)).returning();
    return result[0];
  }

  // ==================== CLASH MATCHES ====================

  async getClashMatch(id: number): Promise<ClashMatch | undefined> {
    const result = await db.select().from(clashMatches).where(eq(clashMatches.id, id));
    return result[0];
  }

  async getClashMatchesByEvent(eventId: number): Promise<ClashMatch[]> {
    return db.select().from(clashMatches)
      .where(eq(clashMatches.eventId, eventId))
      .orderBy(clashMatches.matchOrder);
  }

  async getClashMatchesByStatus(status: string): Promise<ClashMatch[]> {
    return db.select().from(clashMatches)
      .where(eq(clashMatches.status, status as any))
      .orderBy(desc(clashMatches.createdAt));
  }

  async createClashMatch(data: InsertClashMatch): Promise<ClashMatch> {
    const result = await db.insert(clashMatches).values(data).returning();
    return result[0];
  }

  async updateClashMatch(id: number, data: Partial<ClashMatch>): Promise<ClashMatch | undefined> {
    const result = await db.update(clashMatches)
      .set(data)
      .where(eq(clashMatches.id, id))
      .returning();
    return result[0];
  }

  // ==================== CLASH RESULTS ====================

  async getClashResultsByMatch(matchId: number): Promise<ClashResult[]> {
    return db.select().from(clashResults)
      .where(eq(clashResults.clashMatchId, matchId));
  }

  async createClashResult(data: InsertClashResult): Promise<ClashResult> {
    const result = await db.insert(clashResults).values(data).returning();
    return result[0];
  }

  // ==================== CLASH ELO RATINGS ====================

  async getClashEloRating(agentProfileId: number): Promise<ClashEloRating | undefined> {
    const result = await db.select().from(clashEloRatings)
      .where(eq(clashEloRatings.agentProfileId, agentProfileId));
    return result[0];
  }

  async getClashLeaderboard(limit: number = 50): Promise<(ClashEloRating & { profileName: string; providerName: string | null })[]> {
    const result = await db.select({
      id: clashEloRatings.id,
      agentProfileId: clashEloRatings.agentProfileId,
      rating: clashEloRatings.rating,
      matchCount: clashEloRatings.matchCount,
      winCount: clashEloRatings.winCount,
      lossCount: clashEloRatings.lossCount,
      drawCount: clashEloRatings.drawCount,
      updatedAt: clashEloRatings.updatedAt,
      profileName: clashAgentProfiles.name,
      providerName: providers.name,
    })
    .from(clashEloRatings)
    .innerJoin(clashAgentProfiles, eq(clashEloRatings.agentProfileId, clashAgentProfiles.id))
    .leftJoin(providers, eq(clashAgentProfiles.providerId, providers.id))
    .where(eq(clashAgentProfiles.visibility, "public"))
    .orderBy(desc(clashEloRatings.rating))
    .limit(limit);
    return result;
  }

  async upsertClashEloRating(agentProfileId: number, updates: { rating: number; matchCount: number; winCount: number; lossCount: number; drawCount: number }): Promise<ClashEloRating> {
    const existing = await this.getClashEloRating(agentProfileId);
    if (existing) {
      const result = await db.update(clashEloRatings)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(clashEloRatings.agentProfileId, agentProfileId))
        .returning();
      return result[0];
    }
    const result = await db.insert(clashEloRatings)
      .values({ agentProfileId, ...updates })
      .returning();
    return result[0];
  }

  // ==================== CLASH RUNNER POOL ====================

  async getClashRunner(id: number): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.id, id));
    return result[0];
  }

  async getClashRunnerByTokenHash(tokenHash: string): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.tokenHash, tokenHash));
    return result[0];
  }

  async getIdleClashRunner(region: string): Promise<ClashRunner | undefined> {
    const result = await db.select().from(clashRunnerPool)
      .where(and(eq(clashRunnerPool.state, "idle"), eq(clashRunnerPool.siteId, region as any)))
      .limit(1);
    return result[0];
  }

  async registerClashRunner(data: { runnerId: string; tokenHash: string; siteId: string }): Promise<ClashRunner> {
    // Upsert on tokenHash — one token = one runner slot; runnerId updates on restart
    const existing = await db.select().from(clashRunnerPool).where(eq(clashRunnerPool.tokenHash, data.tokenHash));
    if (existing[0]) {
      // Reset orphaned match only if it still belongs to THIS runner's old runnerId.
      // With multiple runners, another runner may have already claimed the match.
      if (existing[0].currentMatchId && existing[0].runnerId) {
        const orphanedMatch = await this.getClashMatch(existing[0].currentMatchId);
        if (orphanedMatch
            && (orphanedMatch.status === "starting" || orphanedMatch.status === "live")
            && orphanedMatch.runnerId === existing[0].runnerId) {
          await db.update(clashMatches)
            .set({ status: "pending", runnerId: null, startedAt: null })
            .where(eq(clashMatches.id, existing[0].currentMatchId));
          console.log(`[ClashRunner] Reset orphaned match #${existing[0].currentMatchId} to pending (runner ${existing[0].runnerId} re-registered as ${data.runnerId})`);
        }
      }
      const result = await db.update(clashRunnerPool)
        .set({ runnerId: data.runnerId, state: "idle", lastHeartbeatAt: new Date(), currentMatchId: null })
        .where(eq(clashRunnerPool.tokenHash, data.tokenHash)).returning();
      return result[0];
    }
    const result = await db.insert(clashRunnerPool).values({ ...data, siteId: data.siteId as any, state: "idle", lastHeartbeatAt: new Date() }).returning();
    return result[0];
  }

  async updateClashRunner(id: number, data: Partial<ClashRunner>): Promise<ClashRunner | undefined> {
    const result = await db.update(clashRunnerPool).set(data).where(eq(clashRunnerPool.id, id)).returning();
    return result[0];
  }

  async getAllClashRunners(): Promise<ClashRunner[]> {
    return db.select().from(clashRunnerPool).orderBy(desc(clashRunnerPool.createdAt));
  }

  async markStaleRunnersDraining(staleThresholdMs: number = 45000): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const result = await db.update(clashRunnerPool)
      .set({ state: "draining" })
      .where(and(not(eq(clashRunnerPool.state, "draining")), sql`${clashRunnerPool.lastHeartbeatAt} < ${cutoff}`))
      .returning();
    return result.length;
  }

  async removeStaleRunners(drainingThresholdMs: number = 3600_000): Promise<number> {
    const cutoff = new Date(Date.now() - drainingThresholdMs);
    const result = await db.delete(clashRunnerPool)
      .where(and(eq(clashRunnerPool.state, "draining"), sql`${clashRunnerPool.lastHeartbeatAt} < ${cutoff}`))
      .returning();
    return result.length;
  }

  /**
   * Fail matches whose runner never completed. The cutoff is PER MATCH:
   * max_duration_seconds + a fixed buffer for briefings/setup/teardown. A flat
   * cutoff shorter than a match's real wall time would reap healthy matches
   * mid-run and free their runner for double-assignment.
   */
  async failStuckMatches(bufferMs: number = 180_000): Promise<number> {
    const bufferSeconds = Math.ceil(bufferMs / 1000);
    const result = await db.update(clashMatches)
      .set({ status: "failed", error: "Match timed out — runner did not complete", completedAt: new Date() })
      .where(and(
        eq(clashMatches.status, "starting"),
        sql`${clashMatches.startedAt} < now() - make_interval(secs => ${clashMatches.maxDurationSeconds} + ${bufferSeconds})`,
      ))
      .returning();
    // Reset any runners stuck on these matches
    for (const match of result) {
      await db.update(clashRunnerPool)
        .set({ state: "idle", currentMatchId: null })
        .where(eq(clashRunnerPool.currentMatchId, match.id));
    }
    return result.length;
  }

  // ==================== CLASH RUNNER ISSUED TOKENS ====================

  async createClashRunnerIssuedToken(token: InsertClashRunnerIssuedToken): Promise<ClashRunnerIssuedToken> {
    const result = await db.insert(clashRunnerIssuedTokens).values(token).returning();
    return result[0];
  }

  async getAllClashRunnerIssuedTokens(): Promise<ClashRunnerIssuedToken[]> {
    return db.select().from(clashRunnerIssuedTokens).orderBy(desc(clashRunnerIssuedTokens.createdAt));
  }

  async getClashRunnerIssuedTokenByHash(tokenHash: string): Promise<ClashRunnerIssuedToken | undefined> {
    const result = await db.select().from(clashRunnerIssuedTokens).where(eq(clashRunnerIssuedTokens.tokenHash, tokenHash));
    return result[0];
  }

  async revokeClashRunnerIssuedToken(id: number): Promise<void> {
    await db.update(clashRunnerIssuedTokens).set({ isRevoked: true }).where(eq(clashRunnerIssuedTokens.id, id));
  }

  async updateClashRunnerIssuedTokenLastUsed(id: number): Promise<void> {
    await db.update(clashRunnerIssuedTokens).set({ lastUsedAt: new Date() }).where(eq(clashRunnerIssuedTokens.id, id));
  }

  // ==================== CLASH TRANSCRIPTS ====================

  async createClashTranscript(data: { clashMatchId: number; speakerLabel: string; text: string; startMs: number; endMs?: number; confidence?: number }): Promise<ClashTranscript> {
    const result = await db.insert(clashTranscripts).values(data).returning();
    return result[0];
  }

  async getClashTranscriptsByMatch(matchId: number): Promise<ClashTranscript[]> {
    return db.select().from(clashTranscripts)
      .where(eq(clashTranscripts.clashMatchId, matchId))
      .orderBy(clashTranscripts.startMs);
  }

  // ==================== CLASH SCHEDULES ====================

  async getClashSchedule(id: number): Promise<ClashSchedule | undefined> {
    const result = await db.select().from(clashSchedules).where(eq(clashSchedules.id, id));
    return result[0];
  }

  async getClashSchedulesByUser(userId: number): Promise<ClashSchedule[]> {
    return db.select().from(clashSchedules)
      .where(eq(clashSchedules.createdBy, userId))
      .orderBy(desc(clashSchedules.createdAt));
  }

  async createClashSchedule(data: InsertClashSchedule): Promise<ClashSchedule> {
    const result = await db.insert(clashSchedules).values(data).returning();
    return result[0];
  }

  async updateClashSchedule(id: number, data: Partial<InsertClashSchedule>): Promise<ClashSchedule | undefined> {
    const result = await db.update(clashSchedules)
      .set({ ...data })
      .where(eq(clashSchedules.id, id))
      .returning();
    return result[0];
  }

  async deleteClashSchedule(id: number): Promise<boolean> {
    const result = await db.delete(clashSchedules).where(eq(clashSchedules.id, id)).returning();
    return result.length > 0;
  }

  async getDueClashSchedules(): Promise<ClashSchedule[]> {
    return db.select().from(clashSchedules)
      .where(
        and(
          eq(clashSchedules.isEnabled, true),
          sql`${clashSchedules.scheduledAt} IS NOT NULL`,
          sql`${clashSchedules.scheduledAt} <= NOW()`
        )
      );
  }

  // ==================== USER STORAGE CONFIG ====================

  async getUserStorageConfig(userId: number): Promise<UserStorageConfig | undefined> {
    const result = await db.select().from(userStorageConfig).where(eq(userStorageConfig.userId, userId));
    return result[0];
  }

  async upsertUserStorageConfig(userId: number, data: Omit<InsertUserStorageConfig, 'userId'>): Promise<UserStorageConfig> {
    const existing = await this.getUserStorageConfig(userId);
    if (existing) {
      const result = await db.update(userStorageConfig)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(userStorageConfig.userId, userId))
        .returning();
      return result[0];
    }
    const result = await db.insert(userStorageConfig).values({ ...data, userId }).returning();
    return result[0];
  }

  async deleteUserStorageConfig(userId: number): Promise<void> {
    await db.delete(userStorageConfig).where(eq(userStorageConfig.userId, userId));
  }

  // ==================== EVAL RESULT ARTIFACTS ====================

  async updateEvalResultArtifacts(evalJobId: number, artifactUrl: string, artifactFiles: unknown): Promise<void> {
    await db.update(evalResults)
      .set({ artifactUrl, artifactFiles, artifactStatus: 'uploaded' })
      .where(eq(evalResults.evalJobId, evalJobId));
  }

  async updateEvalResultArtifactStatus(evalJobId: number, status: string): Promise<void> {
    await db.update(evalResults)
      .set({ artifactStatus: status })
      .where(eq(evalResults.evalJobId, evalJobId));
  }

  async resetStuckArtifactUploads(): Promise<number> {
    const result = await db.update(evalResults)
      .set({ artifactStatus: 'failed' })
      .where(eq(evalResults.artifactStatus, 'uploading'))
      .returning({ id: evalResults.id });
    return result.length;
  }

  // ==================== ORG SECRETS ====================

  async getOrgSecret(organizationId: number, name: string): Promise<OrgSecret | undefined> {
    const result = await db.select().from(orgSecrets)
      .where(and(eq(orgSecrets.organizationId, organizationId), eq(orgSecrets.name, name)));
    return result[0];
  }

  // `upsertOrgSecret` (plaintext-opts writer, partial-update semantics) used to
  // sit here. The console's org-secret routes were re-pointed to the seam's
  // `orgs.upsertOrgSecret` (Core-backed by `upsertOrgSecretRow` below), leaving
  // this one with no production caller at all — only a test seeder, which now
  // seeds through `upsertOrgSecretRow` too. Deleted rather than left orphaned:
  // an unreferenced raw org_secrets WRITER is the same reattachable surface the
  // deleted readers were, and post-flip it would silently mutate the stale Core
  // table. Its one behavioral quirk (partial update — `brokerType`/
  // `isTestAccount` preserved when the opt is omitted) is deliberately not
  // carried over; the provider path always writes both fields explicitly.

  // The org-secret writer, for the vox.organizations seam. Ciphertext-only
  // (the provider never encrypts): the caller has already encrypted the value
  // (or is passing through a value that was never plaintext to Core in the
  // first place), so this stores `row.encryptedValue` verbatim — no encryptValue
  // call here or anywhere in the provider. Preserves createdBy across an update,
  // so the original creator survives rotation (the reason org secrets carry no
  // credential fingerprint — see shared/credentials.ts).
  async upsertOrgSecretRow(
    organizationId: number,
    row: { name: string; encryptedValue: string; brokerType: string | null; isTestAccount: boolean; createdBy: number }
  ): Promise<OrgSecret> {
    const existing = await this.getOrgSecret(organizationId, row.name);
    if (existing) {
      const result = await db.update(orgSecrets)
        .set({
          encryptedValue: row.encryptedValue,
          brokerType: row.brokerType,
          isTestAccount: row.isTestAccount,
          updatedAt: new Date(),
        })
        .where(eq(orgSecrets.id, existing.id))
        .returning();
      return result[0];
    }
    const result = await db.insert(orgSecrets)
      .values({
        organizationId,
        name: row.name,
        encryptedValue: row.encryptedValue,
        createdBy: row.createdBy,
        brokerType: row.brokerType,
        isTestAccount: row.isTestAccount,
      })
      .returning();
    return result[0];
  }

  // Revoke every OTHER active session for a user (keep the caller's current one).
  // Used after a password change/set so a stale or attacker-held session is evicted.
  // Sessions live in user_sessions (connect-pg-simple); the userId is stored in the
  // serialized `sess` JSON.
  async deleteOtherUserSessions(userId: number, keepSid: string): Promise<number> {
    const result = await db.execute(
      sql`DELETE FROM user_sessions WHERE (sess->>'userId')::int = ${userId} AND sid <> ${keepSid}`
    );
    return (result as unknown as { rowCount: number }).rowCount || 0;
  }

  // Pure data access, no authorization: follow job → evalflow → organizationId
  // and report WHICH org owns the run and WHO created it. Null means "this job
  // has no org-secret scope at all" (unknown job, pooled/evalflow-less job, or a
  // personal evalflow) — the personal-secret path handles those.
  //
  // The membership FENCE that used to sit in this method (R3) now lives in Core:
  // server/routes.ts `orgRuntimeSecretsForJob` resolves the creator's membership
  // through the vox.organizations seam and compares it to `evalflowOrgId`.
  // Storage must not re-derive membership here — it would be the last raw-row
  // read of users.organization_id in a business decision.
  async getJobOrgSecretScope(jobId: number): Promise<{ evalflowOrgId: number; createdBy: number | null } | null> {
    const job = await this.getEvalJob(jobId);
    if (!job) return null;
    if (job.evalflowId == null) return null;
    const evalflow = await this.getEvalflow(job.evalflowId);
    if (!evalflow?.organizationId) return null;
    // `?? null` (not `||`): the caller fails closed on a null creator exactly as
    // the old `if (!job.createdBy) return {}` did — org secrets are the SOLE
    // source for an org evalflow, so an unknown creator gets nothing.
    return { evalflowOrgId: evalflow.organizationId, createdBy: job.createdBy ?? null };
  }

  // The org-runtime decrypt tail that used to live here (RUNTIME rows only,
  // brokered rows structurally excluded) moved to Core as
  // `decryptOrgRuntimeRows` in server/routes.ts, beside the fence that is its
  // only caller: its ciphertext rows now come from the `vox.organizations` seam,
  // and the seam traffics in ciphertext only — decryptValue and the key stay on
  // the Core side of the boundary. Nothing outside the provider path reads
  // org-secret DATA through storage any more.

  // ==================== WEB SESSIONS ====================

  // db.execute(sql`...`) goes through drizzle's raw-query path, which (unlike
  // db.select()) disables node-postgres's built-in timestamp parsing and hands
  // back TIMESTAMP/TIMESTAMPTZ/DATE columns as raw strings — snakeToCamel alone
  // would violate WebSession's declared `Date` fields. Parse the known
  // timestamp columns explicitly so callers (notably the mint_started_at
  // fencing token) get real Date instances, matching db.select()'s behavior.
  private static readonly WEB_SESSION_DATE_FIELDS = [
    "mintedAt", "expiresAt", "mintStartedAt", "createdAt", "updatedAt",
  ] as const;

  private rowToWebSession(row: Record<string, unknown>): WebSession {
    const camel = snakeToCamel(row);
    for (const field of DatabaseStorage.WEB_SESSION_DATE_FIELDS) {
      const v = camel[field];
      // Raw-query timestamp strings (e.g. "2026-08-18 12:34:56.789") have no
      // timezone suffix, and the DB clock is UTC — but plain `new Date(v)`
      // parses that shape in the NODE PROCESS's local TZ, not UTC. That
      // disagrees with drizzle's typed column path (db.select(), used by
      // getWebSession), which parses these as UTC. On a non-UTC host this
      // skews every raw-query-derived Date by the host's UTC offset. Force
      // UTC interpretation to match.
      if (typeof v === "string") camel[field] = new Date(v.replace(" ", "T") + "Z");
      else if (v instanceof Date) camel[field] = v;
    }
    return camel as WebSession;
  }

  // The shared-tier login-secret attestation predicate that used to live here
  // moved to Core as `areLoginSecretsAttested` in server/auth-session.ts: its
  // org arm reads through the `vox.organizations` seam now, and storage must not
  // read org-secret data to settle a business question. Its personal arm still
  // calls this class's getSecretsByUserId — from Core, as any other caller does.

  private webSessionScopeWhere(scope: SessionScope) {
    return "userId" in scope
      ? and(eq(webSessions.userId, scope.userId), isNull(webSessions.organizationId))
      : and(eq(webSessions.organizationId, scope.organizationId), isNull(webSessions.userId));
  }

  async getWebSession(scope: SessionScope, platformId: string, credentialKey: string): Promise<WebSession | undefined> {
    const rows = await db.select().from(webSessions)
      .where(and(
        this.webSessionScopeWhere(scope),
        eq(webSessions.platformId, platformId),
        eq(webSessions.credentialKey, credentialKey),
      ));
    return rows[0];
  }

  /**
   * Single-flight mint claim. Returns the row (status now 'minting') when THIS
   * caller won and must mint; undefined when another instance holds a live mint
   * or a fresh 'ready' session already exists. A 'minting' row older than
   * staleMintSeconds is reclaimable (a Core instance died mid-mint).
   *
   * The claim is a single query per branch (INSERT ... RETURNING or
   * UPDATE ... RETURNING), converted straight to the typed row via
   * snakeToCamel — no re-read of the row afterward. A re-read would open a
   * TOCTOU window: by the time it runs, a stale-reclaim from another instance
   * could have already overwritten the row this caller just claimed, so the
   * caller would mint under a false belief that it holds the claim.
   *
   * The returned row's mintStartedAt is the fencing token the caller MUST
   * carry through to storeWebSessionReady/markWebSessionFailed — see there.
   */
  async claimWebSessionMint(
    scope: SessionScope, platformId: string, credentialKey: string,
    staleMintSeconds: number, freshMarginSeconds: number,
  ): Promise<WebSession | undefined> {
    const userId = "userId" in scope ? scope.userId : null;
    const orgId = "organizationId" in scope ? scope.organizationId : null;
    // First-use: create the row already claimed. ON CONFLICT targets the
    // partial unique index matching this scope (now keyed by credential_key
    // too, so two credential pairs on one platform never collide into one row).
    const conflictTarget = userId != null
      ? sql`(user_id, platform_id, credential_key) WHERE organization_id IS NULL`
      : sql`(organization_id, platform_id, credential_key) WHERE user_id IS NULL`;
    // Truncated to milliseconds: JS Date has no sub-millisecond precision, and
    // mint_started_at round-trips through a Date on its way back in as the
    // fencing token (rowToWebSession). Storing raw NOW() (microsecond
    // precision) would make that round-trip lossy and the fence's exact-match
    // WHERE in storeWebSessionReady/markWebSessionFailed would never match.
    const nowMs = sql`date_trunc('milliseconds', NOW())`;
    const inserted = await db.execute(sql`
      INSERT INTO web_sessions (user_id, organization_id, platform_id, credential_key, status, mint_started_at)
      VALUES (${userId}, ${orgId}, ${platformId}, ${credentialKey}, 'minting', ${nowMs})
      ON CONFLICT ${conflictTarget} DO NOTHING
      RETURNING *`);
    const insRows = (inserted as unknown as { rows: Record<string, unknown>[] }).rows;
    if (insRows?.length) return this.rowToWebSession(insRows[0]);
    // Row exists: claim unless someone is live-minting or it's fresh-ready.
    const updated = await db.execute(sql`
      UPDATE web_sessions
      SET status = 'minting', mint_started_at = ${nowMs}, updated_at = NOW()
      WHERE user_id IS NOT DISTINCT FROM ${userId}
        AND organization_id IS NOT DISTINCT FROM ${orgId}
        AND platform_id = ${platformId}
        AND credential_key = ${credentialKey}
        AND (status <> 'minting' OR mint_started_at IS NULL
             OR mint_started_at < NOW() - make_interval(secs => ${staleMintSeconds}))
        AND NOT (status = 'ready' AND expires_at IS NOT NULL
                 AND expires_at > NOW() + make_interval(secs => ${freshMarginSeconds}))
      RETURNING *`);
    const updRows = (updated as unknown as { rows: Record<string, unknown>[] }).rows;
    if (!updRows?.length) return undefined;
    return this.rowToWebSession(updRows[0]);
  }

  /**
   * Marks a claimed row 'ready'. `fence` must be the mintStartedAt the caller
   * received from claimWebSessionMint. The WHERE re-checks status='minting'
   * AND mint_started_at=fence, so a caller whose claim was superseded by a
   * stale-reclaim (its mint_started_at moved on) writes nothing instead of
   * clobbering the new minter's in-flight row. Returns true iff this call's
   * row was the one updated.
   */
  async storeWebSessionReady(
    id: number, encryptedStorageState: string, ttlHours: number, fence: Date,
  ): Promise<boolean> {
    // Send the fence as an explicit ISO UTC string rather than the raw Date
    // (node-postgres would otherwise serialize it using the driver's/host's
    // local-TZ formatting). Postgres ignores the trailing "Z" when coercing
    // a string literal to timestamp-without-time-zone, so the digits it
    // compares are exactly what's stored — and the stored value was written
    // from the (UTC) DB clock via NOW(), so this matches under every node TZ.
    const result = await db.execute(sql`
      UPDATE web_sessions
      SET status = 'ready', encrypted_storage_state = ${encryptedStorageState},
          minted_at = NOW(), expires_at = NOW() + make_interval(secs => ${Math.round(ttlHours * 3600)}),
          last_error = NULL, updated_at = NOW()
      WHERE id = ${id} AND status = 'minting' AND mint_started_at = ${fence.toISOString()}`);
    return ((result as unknown as { rowCount: number }).rowCount || 0) > 0;
  }

  /**
   * Marks a claimed row 'failed'. Same fence guard as storeWebSessionReady —
   * a superseded minter's late failure report must be a no-op, not an
   * overwrite of whatever the reclaiming instance is now doing with the row.
   * expires_at is cleared so a 'failed' row never carries a stale future
   * expiry (consumers gate on status, but the row stays self-consistent).
   * Returns true iff this call's row was the one updated.
   */
  async markWebSessionFailed(id: number, error: string, fence: Date): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE web_sessions
      SET status = 'failed', encrypted_storage_state = NULL, expires_at = NULL,
          last_error = ${error.slice(0, 2000)}, updated_at = NOW()
      WHERE id = ${id} AND status = 'minting' AND mint_started_at = ${fence.toISOString()}`);
    return ((result as unknown as { rowCount: number }).rowCount || 0) > 0;
  }
}

export const storage = new DatabaseStorage();
