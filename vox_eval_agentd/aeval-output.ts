/**
 * Pure helpers for interpreting an aeval run's console output.
 * Kept in its own module (not vox-agentd.ts) so tests can import it without
 * pulling in the daemon entrypoint, which runs main() and calls process.exit.
 * Daemon-local rather than shared/: nothing outside the daemon uses it.
 */

/**
 * Pick the most informative line from a failed aeval run.
 *
 * The old heuristic — last line of stderr — is actively wrong for a
 * PyInstaller-packaged binary: its generic
 * "[PYI-####:ERROR] Failed to execute script 'pyi_entrypoint'..." banner is
 * printed AFTER the real traceback, so the one line we kept was structurally
 * guaranteed to be the least useful one.
 *
 * Order of preference:
 *  1. aeval's own loguru ERROR lines (its actual diagnosis, e.g.
 *     "Step 1 failed: platform.setup - Unknown variable source: secrets").
 *     Scans BOTH streams — loguru's sink may be either.
 *  2. Otherwise the last few non-noise lines, so we surface a traceback tail
 *     rather than the packaging banner.
 */
/**
 * A loguru ERROR/CRITICAL line — aeval's own diagnosis of what went wrong.
 *
 * `[^\S\n]` (horizontal whitespace), never `\s`: `\s` matches newlines, so the
 * old `/\|\s*(ERROR|CRITICAL)\s*\|/` could match ACROSS a line break. That made
 * hasAevalDiagnosis (run over a whole buffer) disagree with the per-line filter
 * below — "dump: foo |\nERROR |x| y" satisfied the former and no line satisfied
 * the latter. Anchored per line with /m so the two agree by construction.
 */
const DIAGNOSIS_LINE = /^[^\n]*\|[^\S\n]*(ERROR|CRITICAL)[^\S\n]*\|/m;

/**
 * A diagnosis line carrying loguru's full `TIMESTAMP | LEVEL |` prefix.
 *
 * Deliberately stricter than DIAGNOSIS_LINE, for deciding whether UNTRUSTED
 * output may be surfaced. A page dump or target-site text can easily contain
 * "| ERROR |"; reproducing a loguru timestamp prefix by accident is far less
 * likely. The lenient form stays in use for the stream we already trust, so
 * tightening admission cannot regress the primary fix if aeval's log format
 * shifts.
 */
const LOGURU_DIAGNOSIS_LINE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+[^\S\n]*\|[^\S\n]*(ERROR|CRITICAL)[^\S\n]*\|/m;

/**
 * Whether a stream carries aeval's own diagnosis. Exported so callers can
 * decide WHICH stream to summarize without restating the regex.
 */
export function hasAevalDiagnosis(text: string): boolean {
  return DIAGNOSIS_LINE.test(text);
}

/**
 * Whether a stream carries a diagnosis in loguru's own line format. Used to
 * admit an untrusted stream (the broker's stdout) into a user-visible error.
 */
export function hasLoguruDiagnosis(text: string): boolean {
  return LOGURU_DIAGNOSIS_LINE.test(text);
}

export function summarizeAevalFailure(stdout: string, stderr: string, redact: string[] = []): string {
  const NOISE = /^\s*(\[PYI-\d+[^\]]*\]|Traceback \(most recent call last\):)/;
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Strip loguru's "TIMESTAMP | LEVEL | " prefix for a compact message.
  const strip = (l: string) => l.replace(/^\S+\s+\S+\s*\|\s*\w+\s*\|\s*/, '').trim();

  // resolveSecrets substitutes DECRYPTED values into the YAML handed to aeval,
  // so any ERROR line echoing step params can carry a live credential — and this
  // string is persisted as the job's error, visible in the console. Scrub every
  // known value before anything is returned.
  // A value may span lines (PEM key, JSON blob) while `lines` above is already
  // split+trimmed, so no single line contains the whole thing — redact each of
  // its lines too, or fragments would survive.
  //
  // Floor is 4, deliberately low: the failure modes are asymmetric. Over-
  // redacting is cosmetic (a secret whose value is literally "prod" garbles a
  // word); under-redacting puts a live credential in a persisted, user-visible
  // job error. Short PINs and account IDs are exactly the values a higher floor
  // would leak.
  const needles = Array.from(
    new Set(redact.flatMap((v) => (v ? [v, ...v.split('\n')] : []).map((x) => x.trim()))),
  )
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length); // longest first, so wholes beat fragments
  const scrub = (text: string) =>
    needles.reduce((acc, value) => acc.split(value).join('[redacted]'), text);

  const errors = lines.filter((l) => DIAGNOSIS_LINE.test(l)).map(strip);
  if (errors.length > 0) {
    // Take the LAST errors, not the first: in a long run an early recoverable
    // ERROR would otherwise bury the fatal one — the same "wrong line wins"
    // failure this helper exists to fix. For a short trace the two coincide.
    return scrub(errors.slice(-3).join(' | ')).slice(0, 500);
  }

  const meaningful = lines.filter((l) => !NOISE.test(l));
  const tail = (meaningful.length > 0 ? meaningful : lines).slice(-3).join(' | ');
  return scrub(tail || 'unknown error').slice(0, 500);
}
