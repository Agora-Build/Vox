/**
 * ${config.*} / ${secrets.*} filling — the pure part, shared by the eval agent
 * (which fills a job with it) and Core (which releases to the agent only the
 * secrets it will fill, #203). One implementation, so the two cannot disagree.
 * Design: designs/2026-09-29-secret-substitution.md.
 *
 * - Works on PARSED values, so a placeholder needs no quoting rules:
 *   `number: ${secrets.X}` and `number: "${secrets.X}"` both work.
 * - Setup/Teardown (the eval flow's own steps) are always filled. The scenario
 *   comes from the eval set, which may belong to someone else: it gets the
 *   eval flow's secrets only when Vox stamped `evalSetSecrets: true` on the job
 *   (server/auth-session.ts evalSetMayUseSecrets). ${config.*} is filled
 *   everywhere.
 * - restful.request steps are never touched: Vox's server fills them from the
 *   job snapshot with secrets it never hands to an agent.
 *
 * Dependency-free (no fs, no YAML parser): callers parse.
 */
import { collectSecretRefs, resolveSecretPlaceholders, unresolvedSecretsMessage, untrustedEvalSetSecretsMessage } from "./secrets";

export interface JobParts {
  scenario: unknown;
  stepsPrefix: unknown;
  stepsSuffix: unknown;
}

export interface FilledJob {
  parts: JobParts;
  /** Secret names the filled parts reference that the server did not supply. */
  unsupplied: string[];
  /** Secret names actually filled into this job — the only values to redact. */
  used: string[];
}

/**
 * Bounds on a part, counted with YAML aliases EXPANDED — the shape every later
 * consumer sees (these walks, JSON.stringify, YAML dump with noRefs, aeval). A
 * parsed alias is a shared reference, so a ~1 KB document of nested aliases
 * ("billion laughs") expands exponentially and exhausts memory. Far above any
 * real eval set; the count stops as soon as a bound is crossed.
 */
export const MAX_FILL_NODES = 200_000;
const MAX_FILL_DEPTH = 64;

/** Whether a parsed part stays within MAX_FILL_NODES / depth, aliases expanded. */
export function withinBounds(v: unknown): boolean {
  let nodes = 0;
  const rec = (x: unknown, depth: number): boolean => {
    if (++nodes > MAX_FILL_NODES || depth > MAX_FILL_DEPTH) return false;
    if (Array.isArray(x)) return x.every((y) => rec(y, depth + 1));
    if (x && typeof x === "object") return Object.values(x).every((y) => rec(y, depth + 1));
    return true;
  };
  return rec(v, 0);
}

export const TOO_COMPLEX_MESSAGE =
  `The job's scenario or Setup/Teardown is too large once its YAML anchors/aliases are expanded ` +
  `(over ${MAX_FILL_NODES.toLocaleString("en-US")} nodes or ${MAX_FILL_DEPTH} levels deep)`;

const isRestful = (v: unknown) =>
  !!v && typeof v === 'object' && (v as Record<string, unknown>).type === 'restful.request';

/** Apply fn to every string, leaving restful.request steps as they are. */
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (isRestful(v)) return v;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  }
  return v;
}

/** Secret refs in a value, ignoring restful.request steps (Core's to fill). */
function refsOutsideRestful(v: unknown): Set<string> {
  const names = new Set<string>();
  mapStrings(v, (s) => {
    collectSecretRefs([s]).forEach((n) => names.add(n));
    return s;
  });
  return names;
}

/** String job-config values usable as ${config.KEY}. */
export function jobConfigVars(config: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string' && k !== 'scenario' && k !== 'framework') vars[k] = v;
  }
  return vars;
}

export function fillJobPlaceholders(
  parts: JobParts,
  config: Record<string, string>,
  secrets: Record<string, string>,
  opts: { evalSetSecrets: boolean },
): FilledJob {
  // First, before any walk: everything below is linear in the EXPANDED size.
  for (const part of [parts.scenario, parts.stepsPrefix, parts.stepsSuffix]) {
    if (!withinBounds(part)) throw new Error(TOO_COMPLEX_MESSAGE);
  }
  const fillConfig = (v: unknown) =>
    mapStrings(v, (s) => s.replace(/\$\{config\.(\w+)\}/g, (m, key) => config[key] ?? m));
  const withConfig: JobParts = {
    scenario: fillConfig(parts.scenario),
    stepsPrefix: fillConfig(parts.stepsPrefix),
    stepsSuffix: fillConfig(parts.stepsSuffix),
  };
  const filled = [withConfig.stepsPrefix, withConfig.stepsSuffix];
  if (opts.evalSetSecrets) filled.push(withConfig.scenario);

  // Taken BEFORE filling: a secret whose value happens to contain
  // "${secrets.X}" must not read as an unresolved placeholder afterwards.
  const unsupplied = new Set<string>();
  const used = new Set<string>();
  for (const v of filled) {
    refsOutsideRestful(v).forEach((n) => (n in secrets ? used : unsupplied).add(n));
  }

  const fillSecrets = (v: unknown) => mapStrings(v, (s) => resolveSecretPlaceholders(s, secrets));
  return {
    parts: {
      scenario: opts.evalSetSecrets ? fillSecrets(withConfig.scenario) : withConfig.scenario,
      stepsPrefix: fillSecrets(withConfig.stepsPrefix),
      stepsSuffix: fillSecrets(withConfig.stepsSuffix),
    },
    unsupplied: Array.from(unsupplied),
    used: Array.from(used),
  };
}

/**
 * The job error for secret references left in what will actually run, or null.
 * Call it on the parts as they will run — after web session injection, which
 * legitimately removes brokered login references.
 */
export function unresolvedSecretsError(
  filled: FilledJob,
  finalParts: JobParts,
  opts: { evalSetSecrets: boolean },
): string | null {
  if (!opts.evalSetSecrets) {
    const inEvalSet = Array.from(refsOutsideRestful(finalParts.scenario)).sort();
    if (inEvalSet.length > 0) {
      return untrustedEvalSetSecretsMessage(inEvalSet);
    }
  }
  const remaining = refsOutsideRestful([finalParts.scenario, finalParts.stepsPrefix, finalParts.stepsSuffix]);
  const unresolved = filled.unsupplied.filter((n) => remaining.has(n));
  return unresolved.length > 0 ? unresolvedSecretsMessage(unresolved) : null;
}
