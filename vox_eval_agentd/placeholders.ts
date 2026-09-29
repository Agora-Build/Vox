/**
 * The eval agent's side of secret handling (design:
 * designs/2026-09-29-secret-substitution.md). The filling itself lives in
 * shared/placeholders.ts — shared with Core, which releases to the agent only
 * the secrets it will fill — and is re-exported here. This file adds what only
 * the agent does: write filled parts back to YAML, and keep secret values out
 * of logs, errors and artifacts (needles, the redacting logger, the artifact
 * scrub).
 */
import { MIN_SECRET_VALUE_LENGTH, SECRET_LINE_BREAK, secretValueError } from '../shared/secrets';
// The filling itself is shared with Core (shared/placeholders.ts).
export {
  fillJobPlaceholders, jobConfigVars, unresolvedSecretsError, type JobParts, type FilledJob,
} from '../shared/placeholders';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { redactValues, urlForms } from '../shared/credentials';

/** A filled part back to the YAML aeval reads. */
export function toYaml(value: unknown): string {
  return yaml.dump(value, { lineWidth: -1, noRefs: true });
}

/** Double-quoted-YAML escaping: how a value can appear in YAML aeval reads. */
function yamlEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/** Redaction targets shorter than this would corrupt unrelated text. */
export const MIN_REDACT_LENGTH = MIN_SECRET_VALUE_LENGTH;

/**
 * The job error when a secret the job uses can't be kept out of logs, errors
 * and artifacts (secretValueError: too short, or a short line with letters or
 * digits), or null. Vox no longer stores such a value; this refuses a job
 * that uses one stored earlier, before it runs. Names only, never a value.
 */
export function shortSecretsError(used: Record<string, string>): string | null {
  const names = Object.keys(used).filter((n) => secretValueError(used[n]) !== null).sort();
  if (names.length === 0) return null;
  return `Secret(s) ${names.join(', ')} can't be kept out of logs, errors and artifacts: a value, and ` +
    `each line of it that contains letters or digits, must be at least ${MIN_REDACT_LENGTH} characters. ` +
    `Update ${names.length > 1 ? 'them' : 'it'} under Console → Secrets.`;
}

/**
 * Every spelling of the secret values that must be redacted from job output,
 * errors and logs: raw, YAML-escaped, the URL encodings (shared with the
 * broker), and each line of a multi-line value. Pass only the secrets the job actually used (FilledJob.used) —
 * the server hands over every runtime secret of the owner.
 * Deduped: for an alphanumeric secret they are all the same string.
 */
export function secretNeedles(secrets: Record<string, string>): string[] {
  return Array.from(new Set(
    Object.values(secrets)
      .filter((v) => v.length > 0)
      .flatMap((v) => [v, yamlEscape(v), ...urlForms(v), ...lineFragments(v)]),
  ));
}

/**
 * Each line of a multi-line value, as its own needle: output that echoes the
 * value re-indented (a YAML block scalar, a pretty-printer) never contains the
 * whole value, only its lines. Lines under MIN_REDACT_LENGTH are punctuation
 * only (secretValueError guarantees it) and carry no secret.
 */
function lineFragments(value: string): string[] {
  const lines = value.split(SECRET_LINE_BREAK).map((l) => l.trim());
  return lines.length > 1 ? lines.filter((l) => l.length >= MIN_REDACT_LENGTH) : [];
}

const MAX_TEXT_SCRUB_BYTES = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const SCAN_CHUNK_BYTES = 1024 * 1024;

export interface ScrubResult {
  /** Files rewritten (text) or deleted (a binary holding a secret, or text too big to scrub). */
  changed: string[];
  /** Of `changed`, the files deleted — logged by name so a lost artifact can be diagnosed. */
  deleted: string[];
  /** Files that could not be checked or removed — the job's artifacts must not be uploaded. */
  failed: string[];
}

/**
 * Audio containers (WAV/OGG/FLAC/MP3) by magic bytes. Recordings are the
 * job's main artifact and their samples cannot carry a secret as text, but a
 * short needle matches random PCM bytes by chance often enough to delete a
 * recording — so they are never byte-scanned.
 */
function isAudio(head: Buffer): boolean {
  const at = (i: number, sig: string) => head.subarray(i, i + sig.length).toString('latin1') === sig;
  return (at(0, 'RIFF') && at(8, 'WAVE')) || at(0, 'OggS') || at(0, 'fLaC') || at(0, 'ID3') ||
    (head.length > 1 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
}

/** Whether any needle occurs in the file — read in chunks, with overlap so a match across a boundary is found. */
function fileContains(p: string, needles: Buffer[]): boolean {
  const overlap = Math.max(...needles.map((n) => n.length)) - 1;
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES + overlap);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, carry, SCAN_CHUNK_BYTES, pos);
      if (read === 0) return false;
      const window = buf.subarray(0, carry + read);
      if (needles.some((n) => window.includes(n))) return true;
      pos += read;
      carry = Math.min(overlap, window.length);
      window.copy(buf, 0, window.length - carry);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove secret values from every artifact under dirs, in place, before upload
 * (the uploader sends every regular file). e.g. DialF's steps.json records a
 * call.dial number kept as a secret; aeval's output can hold a copy of the
 * filled scenario.
 *
 * Text vs binary is decided by content (a NUL byte in the first 8 KB), not by
 * file name. Text is redacted byte-for-byte (nothing else in the file
 * changes); text over MAX_TEXT_SCRUB_BYTES is deleted rather than uploaded
 * unscrubbed. A binary that contains a secret cannot be redacted safely and is
 * deleted; audio is never byte-scanned (see isAudio). Best-effort per file and
 * fail-closed: a file that cannot be handled is deleted, and one that cannot
 * even be deleted is reported in `failed`.
 */
export function scrubSecretsFromArtifacts(dirs: string[], needles: string[]): ScrubResult {
  const result: ScrubResult = { changed: [], deleted: [], failed: [] };
  const values = needles.filter((v) => v.length > 0);
  if (values.length === 0) return result;
  const needleBytes = values.map((v) => Buffer.from(v, 'utf-8'));
  // Text is edited as latin1 — one char per byte — so bytes that are not valid
  // UTF-8 survive untouched; the needles are their UTF-8 bytes in the same form.
  const needleLatin1 = needleBytes.map((b) => b.toString('latin1'));
  const remove = (p: string) => {
    try {
      fs.rmSync(p, { force: true });
      result.changed.push(p);
      result.deleted.push(p);
    } catch {
      result.failed.push(p);
    }
  };
  const scrubFile = (p: string) => {
    const size = fs.statSync(p).size;
    const head = Buffer.alloc(Math.min(size, BINARY_SNIFF_BYTES));
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    if (head.includes(0)) {
      if (!isAudio(head) && fileContains(p, needleBytes)) remove(p);
      return;
    }
    if (size > MAX_TEXT_SCRUB_BYTES) { remove(p); return; }
    const text = fs.readFileSync(p).toString('latin1');
    const clean = redactValues(text, needleLatin1);
    if (clean !== text) { fs.writeFileSync(p, Buffer.from(clean, 'latin1')); result.changed.push(p); }
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

/**
 * Line-buffered logger for a child process's output that redacts every
 * complete line before emitting it — aeval echoes filled steps, URLs and
 * errors, and none may reach the agent's logs. Feed it DECODED text (a
 * StringDecoder keeps multi-byte characters whole). Pass secretNeedles: they
 * include each line of a multi-line value, which is split across lines here.
 */
export function createRedactingLineLogger(emit: (line: string) => void, needles: string[]) {
  const pieces = needles.filter((v) => v.length > 0);
  let pending = '';
  const out = (line: string) => {
    const clean = redactValues(line, pieces).trim();
    if (clean) emit(clean);
  };
  return {
    write(text: string) {
      pending += text;
      const lines = pending.split(SECRET_LINE_BREAK);
      pending = lines.pop() ?? '';
      for (const l of lines) out(l);
    },
    flush() {
      if (pending) out(pending);
      pending = '';
    },
  };
}
