/**
 * ${config.*} / ${secrets.*} filling — one implementation for web and phone
 * jobs (design: designs/2026-09-29-secret-substitution.md).
 *
 * - Works on PARSED values, so a placeholder needs no quoting rules:
 *   `number: ${secrets.X}` and `number: "${secrets.X}"` both work.
 * - Setup/Teardown (the eval flow's own steps) are always filled. The scenario
 *   comes from the eval set, which may belong to someone else: it gets the
 *   eval flow owner's secrets only when Vox stamped `evalSetSecrets: true` on
 *   the job (same owner or same org). ${config.*} is filled everywhere.
 * - restful.request steps are never touched: Vox's server fills them from the
 *   job snapshot with secrets it never hands to an agent.
 */
import { collectSecretRefs, resolveSecretPlaceholders, unresolvedSecretsMessage } from '../shared/secrets';
import * as fs from 'fs';
import * as path from 'path';
import { redactValues, urlForms } from '../shared/credentials';

export interface JobParts {
  scenario: unknown;
  stepsPrefix: unknown;
  stepsSuffix: unknown;
}

export interface FilledJob {
  parts: JobParts;
  /** Secret names the filled parts reference that the server did not supply. */
  unsupplied: string[];
}

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
    for (const n of collectSecretRefs([s])) names.add(n);
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
  for (const v of filled) for (const n of refsOutsideRestful(v)) if (!(n in secrets)) unsupplied.add(n);

  const fillSecrets = (v: unknown) => mapStrings(v, (s) => resolveSecretPlaceholders(s, secrets));
  return {
    parts: {
      scenario: opts.evalSetSecrets ? fillSecrets(withConfig.scenario) : withConfig.scenario,
      stepsPrefix: fillSecrets(withConfig.stepsPrefix),
      stepsSuffix: fillSecrets(withConfig.stepsSuffix),
    },
    unsupplied: [...unsupplied],
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
    const inEvalSet = [...refsOutsideRestful(finalParts.scenario)].sort();
    if (inEvalSet.length > 0) {
      return `The eval set uses secret(s) ${inEvalSet.join(', ')}, but it belongs to someone other ` +
        `than this eval flow's owner. An eval set may use the eval flow owner's secrets only when ` +
        `the same person or organization owns both.`;
    }
  }
  const remaining = refsOutsideRestful([finalParts.scenario, finalParts.stepsPrefix, finalParts.stepsSuffix]);
  const unresolved = filled.unsupplied.filter((n) => remaining.has(n));
  return unresolved.length > 0 ? unresolvedSecretsMessage(unresolved) : null;
}

/** Double-quoted-YAML escaping: how a value can appear in YAML aeval reads. */
export function yamlEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/**
 * Every spelling of the secret values that must be redacted from job output
 * and errors: raw, YAML-escaped, and the URL encodings (shared with the broker).
 * Deduped: for an alphanumeric secret they are all the same string.
 */
export function secretNeedles(secrets: Record<string, string>): string[] {
  return Array.from(new Set(
    Object.values(secrets).flatMap((v) => [v, yamlEscape(v), ...urlForms(v)]),
  ));
}

/** Artifact files that can carry text — scrubbed; audio and other binaries are not. */
const TEXT_ARTIFACT = /\.(json|ya?ml|log|txt|csv|md|html?)$/i;
const MAX_SCRUB_BYTES = 50 * 1024 * 1024;

/**
 * Remove secret values from every text artifact under dirs, in place, before
 * upload — e.g. DialF's steps.json records a call.dial number kept as a
 * secret, and aeval's output can hold a copy of the filled scenario. Returns
 * the files changed. Files over MAX_SCRUB_BYTES are deleted rather than
 * uploaded unscrubbed.
 */
export function scrubSecretsFromArtifacts(dirs: string[], needles: string[]): string[] {
  const values = needles.filter((v) => v.length > 0);
  if (values.length === 0) return [];
  const changed: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !TEXT_ARTIFACT.test(e.name)) continue;
      if (fs.statSync(p).size > MAX_SCRUB_BYTES) { fs.rmSync(p, { force: true }); changed.push(p); continue; }
      const text = fs.readFileSync(p, 'utf-8');
      const clean = redactValues(text, values);
      if (clean !== text) { fs.writeFileSync(p, clean); changed.push(p); }
    }
  };
  for (const d of dirs) walk(d);
  return changed;
}
