/**
 * Pure helpers for interpreting an aeval run's console output.
 * Kept in its own module (not vox-agentd.ts) so tests can import it without
 * pulling in the daemon entrypoint, which runs main() and calls process.exit.
 * Daemon-local rather than shared/: nothing outside the daemon uses it.
 */

/**
 * A loguru ERROR/CRITICAL line — aeval's own diagnosis of what went wrong.
 *
 * `[ \t]`, never `\s` and not even `[^\S\n]`: `\s` matches every line
 * terminator, and `[^\S\n]` still matches \r, \u2028 and \u2029 (whitespace
 * that isn't \n) — so both could match ACROSS a line break, exactly the
 * disagreement this anchoring exists to remove. That made
 * hasAevalDiagnosis (run over a whole buffer) disagree with the per-line filter
 * below — "dump: foo |\nERROR |x| y" satisfied the former and no line satisfied
 * the latter. Anchored per line with /m so the two agree by construction.
 */
const DIAGNOSIS_LINE = /^[^\n]*\|[ \t]*(ERROR|CRITICAL)[ \t]*\|/m;

/**
 * Every JS LineTerminator, not just \n.
 *
 * The regexes above carry /m, whose `^` anchors after \n, \r, \u2028 and
 * \u2029 — but String.split('\n') breaks on \n alone. Splitting on the
 * narrower set while testing with the wider one lets a chunk like
 *   "cookie=SESSIONVALUE123\r2026-08-30 ... | ERROR | boom"
 * count as ONE line that DIAGNOSIS_LINE matches (anchored after the \r) and
 * that strip() cannot clean, since its prefix pattern is not at index 0. The
 * untrusted prefix then rides out in the reported text. Exported so every
 * caller splitting output shares one definition of "line" with the regexes.
 */
export const LINE_TERMINATORS = /\r?\n|[\r\u2028\u2029]/;

/**
 * A diagnosis line carrying loguru's full `TIMESTAMP | LEVEL |` prefix.
 *
 * Deliberately stricter than DIAGNOSIS_LINE, for deciding whether UNTRUSTED
 * output may be surfaced. A page dump or target-site text can easily contain
 * "| ERROR |"; reproducing a loguru timestamp prefix by accident is far less
 * likely. The lenient form stays in use for the stream we already trust, so
 * tightening admission cannot regress the primary fix if aeval's log format
 * shifts.
 *
 * NOTE: anchored on a leading digit, so a future aeval build that colorizes
 * non-TTY output (ANSI prefix before the timestamp) would stop matching. That
 * degrades safely — the stdout hedge simply admits nothing and we fall back to
 * stderr — but it is worth knowing before debugging a silent hedge.
 */
const LOGURU_DIAGNOSIS_LINE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?[ \t]*\|[ \t]*(ERROR|CRITICAL)[ \t]*\|/m;

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

/**
 * Shortest redaction needle honored. 4 by default; the broker passes 0.
 *
 * Scrubbing happens AFTER line classification and BEFORE truncation, which is
 * what makes a floor of 0 safe to offer: a one-character credential would
 * otherwise have to be scrubbed out of the INPUT, and rewriting the input can
 * destroy the very tokens classification depends on — a password of "E" turns
 * every "ERROR" into "[redacted]RROR", DIAGNOSIS_LINE stops matching, and the
 * summarizer falls back to the tail path and reports the artifacts banner
 * again. Redacting the already-chosen lines cannot do that.
 */
export const DEFAULT_MIN_NEEDLE_LENGTH = 4;

/**
 * Pick the most informative line from a failed aeval run.
 *
 * The old heuristic — last line of stderr — is actively wrong for a
 * PyInstaller-packaged binary: its generic
 * "[PYI-####:ERROR] Failed to execute script 'pyi_entrypoint'..." banner is
 * printed AFTER the real traceback, so the one line we kept was structurally
 * guaranteed to be the least useful one. aeval does the same thing with its
 * trailing "Artifacts saved to: <path>" INFO banner.
 *
 * Order of preference:
 *  1. aeval's own loguru ERROR lines (its actual diagnosis, e.g.
 *     "Step 1 failed: platform.setup - Unknown variable source: secrets"),
 *     taking the LAST few so an early recoverable error can't bury the fatal
 *     one. Scans both arguments — loguru's sink may be either stream.
 *  2. Otherwise the last few non-noise lines, so we surface a traceback tail
 *     rather than the packaging banner.
 *
 * Callers that must not feed untrusted output into (1) should pass '' for that
 * stream — see the broker's selectDiagnosisSource.
 */
export function summarizeAevalFailure(
  stdout: string,
  stderr: string,
  redact: string[] = [],
  minNeedleLength: number = DEFAULT_MIN_NEEDLE_LENGTH,
): string {
  const NOISE = /^\s*(\[PYI-\d+[^\]]*\]|Traceback \(most recent call last\):)/;
  const lines = `${stdout}\n${stderr}`
    .split(LINE_TERMINATORS)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Strip loguru's "TIMESTAMP | LEVEL | " prefix for a compact message.
  // `\S+[ T]?\S*` rather than `\S+\s+\S+`: LOGURU_DIAGNOSIS_LINE accepts a `T`
  // between date and time, and with "2026-08-30T17:49:50 | ERROR | ..." the
  // whitespace-separated form matches nothing, so the line is reported with its
  // prefix un-stripped. Cosmetic, but the two patterns should agree on what a
  // loguru prefix looks like.
  const strip = (l: string) => l.replace(/^\S+(?:\s+\S+)?\s*\|\s*\w+\s*\|\s*/, '').trim();

  // resolveSecrets substitutes DECRYPTED values into the YAML handed to aeval,
  // so any ERROR line echoing step params can carry a live credential — and this
  // string is persisted as the job's error, visible in the console. Scrub every
  // known value before anything is returned.
  // A value may span lines (PEM key, JSON blob) while `lines` above is already
  // split+trimmed, so no single line contains the whole thing — redact each of
  // its lines too, or fragments would survive. Split on LINE_TERMINATORS, the
  // same definition `lines` uses: a secret broken by a bare \r would otherwise
  // be split by the text and not by the needles, and its fragments would match
  // nothing.
  //
  // Default floor is 4, deliberately low: the failure modes are asymmetric.
  // Over-redacting is cosmetic (a secret whose value is literally "prod"
  // garbles a word); under-redacting puts a live credential in a persisted,
  // user-visible job error. Short PINs and account IDs are exactly the values a
  // higher floor would leak. Callers that can accept the cosmetic damage — the
  // broker, where the only needles are one login pair — pass 0 for no floor.
  const needles = Array.from(
    new Set(redact.flatMap((v) => (v ? [v, ...v.split(LINE_TERMINATORS)] : []).map((x) => x.trim()))),
  )
    // `v.length >= 1` is not redundant with the floor: a floor of 0 would admit
    // the empty string, and "".split("") splits between every character, which
    // would replace the entire message with [redacted] separators.
    .filter((v) => v.length >= 1 && v.length >= minNeedleLength)
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
