import { redactValues } from '../shared/credentials';
export { urlForms, credentialForms, redactValues } from '../shared/credentials';

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
const DIAGNOSIS_LINE = /^[^\r\n\u2028\u2029]*\|[ \t]*(ERROR|CRITICAL)[ \t]*\|/m;

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
const DEFAULT_MIN_NEEDLE_LENGTH = 4;

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
  // `\S+(?:\s+\S+)?` rather than `\S+\s+\S+`: LOGURU_DIAGNOSIS_LINE accepts a `T`
  // between date and time, and with "2026-08-30T17:49:50 | ERROR | ..." the
  // date and time are ONE \S+ token — the mandatory second token then matches
  // nothing and the line is reported with its prefix un-stripped. Making the
  // second token optional covers both spellings. Cosmetic, but the two patterns
  // should agree on what a loguru prefix looks like.
  //
  // Making the second token optional also strips a whitespace-free prefix like
  // "cookie=abc|ERROR|x" down to "x". That is wider than the T-spelling this
  // was aimed at, and deliberate to keep: such a line only reaches here from an
  // untrusted stream, and removing the prefix is the safer direction.
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
  // redactValues, not a local reduce: it is the same logic (longest-first,
  // empty dropped) and a second copy is the drift this module argues against.
  // The floor is applied above, since it is specific to this caller.
  const scrub = (text: string) => redactValues(text, needles);

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

export function reduceUrlsToHost(text: string): string {
  return text.replace(
    /((?:https?|wss?):\/\/)(?:[^\s"'<>/?#]*@)?([^\s"'<>/?#]*)(?:[/?#][^\s"'<>]*)?/gi,
    '$1$2/…',
  );
}

/**
 * Reduce URLs in `text`, but redact any needle that IS a URL first.
 *
 * reduceUrlsToHost rewrites `scheme://host/path?query` to `scheme://host/…`.
 * If a CREDENTIAL's value is itself a URL — a LiveKit `wss://<project>.livekit.cloud/...`
 * server URL, a webhook endpoint, a reset link — that rewrite destroys the
 * needle that would have redacted it, and the host survives into a persisted,
 * user-visible error. Redacting the URL-shaped needles first closes that.
 *
 * Pre-redacting is safe for THIS subset specifically: a needle containing "://"
 * cannot occur inside a loguru timestamp/level prefix, so line classification
 * is untouched. That is why the general case still redacts after classifying
 * (see minNeedleLength).
 *
 * Shared by the broker and the daemon so the two cannot diverge on it.
 */
export function reduceUrlsSafely(text: string, needles: string[]): string {
  const urlish = needles
    .filter((n) => n.length > 0 && n.includes('://'))
    .sort((a, b) => b.length - a.length); // longest first, so wholes beat substrings
  // Consume the REST of the URL run, not just the needle. A URL-valued secret
  // is typically a PREFIX of what gets echoed — secret "wss://h/rtc" appearing
  // as "wss://h/rtc?access_token=JWT" — and replacing only the needle leaves
  // "[redacted]?access_token=JWT", which reduceUrlsToHost no longer recognizes
  // as a URL, so the query survives.
  const pre = urlish.reduce(
    (acc, v) => acc.replace(new RegExp(escapeForRegExp(v) + '[^\\s"\'<>|]*', 'g'), '[redacted]'),
    text,
  );
  return reduceUrlsToHost(pre);
}

/** Escape a literal for embedding in a RegExp. */
function escapeForRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Retention target per captured stream — NOT a hard ceiling.
 *
 * The eviction hysteresis below lets `complete` reach 2x this before trimming
 * back to 1x, and `partial` holds up to another 1x, so worst-case retention is
 * ~3x per stream and ~6x per in-flight run or mint. Size a sidecar against that
 * number, not this one.
 *
 * 1 MiB, not something tighter: this exists as an OOM bound, and a multi-minute
 * voice eval emits well past 64 KiB on stdout. Too small a cap makes the
 * daemon's early "Session directory:" line get evicted on ordinary runs — so
 * resolveAevalOutputDir's primary path would be effectively dead in production
 * rather than a rare fallback — and makes the truncation guard on the metrics
 * fallback fire routinely instead of only on runaway output.
 */
export const CAPTURE_LIMIT = 1024 * 1024;

/**
 * Bounded, line-aligned capture of one child stream.
 *
 * /mint is a long-running authenticated endpoint driving a browser, so an
 * unbounded buffer is an OOM waiting for a stuck or noisy run. Keeps the TAIL
 * rather than the head — that is where aeval's diagnosis lives, and
 * summarizeAevalFailure reads the LAST error lines anyway.
 *
 * The retained text NEVER begins mid-line, which is a redaction property, not
 * cosmetics: `scrubCredentials` matches whole credential forms, so a buffer
 * that began inside `password=<secret>` would leave an unmatchable suffix in a
 * string that is logged, returned in the 502 body, and persisted by Core as a
 * user-visible job error.
 *
 * Enforcing that needs state, not a pure append: when the overlong tail has no
 * newline at all there is no safe place to cut, so the line is abandoned AND
 * its continuation must be dropped until the next newline arrives. A pure
 * "slice at cut" would reintroduce the partial-credential leak on the very next
 * chunk.
 */
/** First line terminator in `s`, or null. Non-global regex, so exec is stateless. */
function nextTerminator(s: string): { idx: number; len: number } | null {
  const m = LINE_TERMINATORS.exec(s);
  return m ? { idx: m.index, len: m[0].length } : null;
}

export function createBoundedCapture(limit = CAPTURE_LIMIT) {
  // Whether anything has been discarded. Callers that PARSE the capture (rather
  // than summarizing a failure from it) must check this: a tail-truncated
  // buffer silently changes their answer instead of failing.
  let truncated = false;
  // Retained whole lines; '' or ends with a line terminator. Terminators are
  // the module's LINE_TERMINATORS set, not '\n' alone: a writer that ends lines
  // with a bare \r (Chromium/Playwright progress output inheriting the child's
  // stdio) would otherwise accumulate into `partial` until it tripped the
  // overlong-line guard and got discarded wholesale, swallowing a diagnosis
  // that arrived on the same run of text.
  let complete = '';
  let partial = '';    // the line currently being written
  let dropping = false; // the current line is overlong; discard through its end

  // Evict whole lines from the FRONT until the retained text fits. Never cuts
  // inside a line, which is the redaction property: scrubCredentials matches
  // whole credential forms, so text beginning mid-`password=<secret>` would
  // leave an unmatchable suffix in a logged, persisted, user-visible message.
  // Evicting on every line once `complete` is full is O(limit) per line — the
  // exec and the slice both flatten a 64 KiB ConsString, so a child emitting
  // megabytes of short lines (Chromium debug spew, and /mint drives a browser)
  // costs gigabytes of memcpy. Let it run to 2x before trimming back to 1x, so
  // eviction is amortized O(1). Retained text is therefore bounded by 2*limit,
  // not limit — still bounded, which is the property that matters.
  const evictOldest = () => {
    if (complete.length + partial.length <= limit * 2) return;
    while (complete.length + partial.length > limit && complete.length > 0) {
      const t = nextTerminator(complete);
      complete = t === null ? '' : complete.slice(t.idx + t.len);
      truncated = true;
    }
  };

  return {
    push(chunk: string): void {
      // Scan with a sticky index rather than re-slicing `chunk` per line. The
      // slice-per-line form was O(lines x chunk): a 64 KiB pipe read of 80-char
      // lines meant ~800 iterations each copying ~32 KiB, reintroducing at this
      // level exactly the memcpy volume the eviction hysteresis below removes.
      const scan = new RegExp(LINE_TERMINATORS.source, 'g');
      let pos = 0;
      while (pos < chunk.length) {
        scan.lastIndex = pos;
        const m = scan.exec(chunk);
        if (m === null) {
          const rest = chunk.slice(pos);
          if (dropping) return; // still inside the abandoned line
          partial += rest;
          // A single line larger than the whole budget has no safe cut point:
          // abandon it, and keep abandoning until it ends, so the next chunk's
          // continuation cannot come back as if it were a fresh line.
          if (partial.length > limit) {
            partial = '';
            dropping = true;
            truncated = true;
          }
          // Deliberately NOT evicting here. A huge single line arrives across
          // many chunks, each landing in this branch while still under the cap;
          // evicting would empty `complete` to make room for a line that is
          // then discarded anyway — destroying the diagnosis for a blob that
          // never enters the buffer, which is the exact outcome the
          // overlong-line drop below exists to prevent. `partial` is capped
          // independently, so retained text stays bounded by 3*limit.
          return;
        }
        const lineEnd = m.index + m[0].length;
        const seg = chunk.slice(pos, lineEnd);
        pos = lineEnd;
        if (dropping) {
          dropping = false; // the abandoned line ends here
          continue;
        }
        partial += seg;
        if (partial.length > limit) {
          // Drop just this overlong line: evicting from the front instead
          // would discard the diagnosis already captured, so one ERROR line
          // followed by a 100 KB blob would report nothing useful.
          partial = '';
          truncated = true;
          continue;
        }
        complete += partial;
        partial = '';
        evictOldest();
      }
    },
    get text(): string {
      return complete + partial;
    },
    /**
     * Only the COMPLETE lines — `text` can end mid-line while the child is
     * still writing, and a half-written `password=<secret>` no longer matches
     * its redaction needle. Read this whenever the summary is taken before the
     * child has exited.
     */
    get completeText(): string {
      return complete;
    },
    /** True once any output has been discarded. See the note above. */
    get truncated(): boolean {
      return truncated;
    },
  };
}
