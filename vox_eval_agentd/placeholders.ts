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
import { collectSecretRefs, resolveSecretPlaceholders, unresolvedSecretsMessage, untrustedEvalSetSecretsMessage } from '../shared/secrets';
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
  /** Secret names actually filled into this job — the only values to redact. */
  used: string[];
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
  const used = new Set<string>();
  for (const v of filled) {
    for (const n of refsOutsideRestful(v)) (n in secrets ? used : unsupplied).add(n);
  }

  const fillSecrets = (v: unknown) => mapStrings(v, (s) => resolveSecretPlaceholders(s, secrets));
  return {
    parts: {
      scenario: opts.evalSetSecrets ? fillSecrets(withConfig.scenario) : withConfig.scenario,
      stepsPrefix: fillSecrets(withConfig.stepsPrefix),
      stepsSuffix: fillSecrets(withConfig.stepsSuffix),
    },
    unsupplied: [...unsupplied],
    used: [...used],
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
      return untrustedEvalSetSecretsMessage(inEvalSet);
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
 * Shorter values are not redacted: replacing a 1–3 character string everywhere
 * would corrupt unrelated text (numbers, words) in errors and artifacts. Such a
 * value is not meaningfully secret; the agent logs its NAME as a warning.
 */
export const MIN_REDACT_LENGTH = 4;

/**
 * Every spelling of the secret values that must be redacted from job output
 * and errors: raw, YAML-escaped, and the URL encodings (shared with the
 * broker). Pass only the secrets the job actually used (FilledJob.used) —
 * the server hands over every runtime secret of the owner.
 * Deduped: for an alphanumeric secret they are all the same string.
 */
export function secretNeedles(secrets: Record<string, string>): string[] {
  return Array.from(new Set(
    Object.values(secrets)
      .filter((v) => v.length >= MIN_REDACT_LENGTH)
      .flatMap((v) => [v, yamlEscape(v), ...urlForms(v)]),
  ));
}

const MAX_SCRUB_BYTES = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export interface ScrubResult {
  /** Files rewritten (text) or deleted (a binary holding a secret, or too big to scrub). */
  changed: string[];
  /** Files that could not be checked or removed — the job's artifacts must not be uploaded. */
  failed: string[];
}

/**
 * Remove secret values from every artifact under dirs, in place, before upload
 * (the uploader sends every file). e.g. DialF's steps.json records a call.dial
 * number kept as a secret; aeval's output can hold a copy of the filled
 * scenario.
 *
 * Text vs binary is decided by content (a NUL byte in the first 8 KB), not by
 * file name. Text is redacted; a binary that contains a secret cannot be
 * redacted safely and is deleted; other binaries (recordings) are kept. Text
 * over MAX_SCRUB_BYTES is deleted rather than uploaded unscrubbed. Best-effort
 * per file and fail-closed: a file that cannot be handled is deleted, and one
 * that cannot even be deleted is reported in `failed`.
 */
export function scrubSecretsFromArtifacts(dirs: string[], needles: string[]): ScrubResult {
  const result: ScrubResult = { changed: [], failed: [] };
  const values = needles.filter((v) => v.length > 0);
  if (values.length === 0) return result;
  const needleBytes = values.map((v) => Buffer.from(v, 'utf-8'));
  const remove = (p: string) => {
    try { fs.rmSync(p, { force: true }); result.changed.push(p); } catch { result.failed.push(p); }
  };
  const scrubFile = (p: string) => {
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, 'r');
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(size, BINARY_SNIFF_BYTES));
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const binary = head.includes(0);
    if (binary) {
      if (size > MAX_SCRUB_BYTES) return; // e.g. a long call recording
      const bytes = fs.readFileSync(p);
      if (needleBytes.some((n) => bytes.includes(n))) remove(p);
      return;
    }
    if (size > MAX_SCRUB_BYTES) { remove(p); return; }
    const text = fs.readFileSync(p, 'utf-8');
    const clean = redactValues(text, values);
    if (clean !== text) { fs.writeFileSync(p, clean); result.changed.push(p); }
  };
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.failed.push(dir);
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue; // the uploader sends regular files only
      try { scrubFile(p); } catch { remove(p); }
    }
  };
  for (const d of dirs) walk(d);
  return result;
}
