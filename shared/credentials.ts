import { createHash } from "crypto";

/**
 * Credential redaction primitives, shared by Core, the eval-agent daemon and
 * the auth-session broker.
 *
 * Node-only: it imports `crypto`. That is safe because every consumer runs
 * under Node (Core, the daemon, the broker). The CLIENT-safe shared module is
 * `shared/secrets.ts`; keep it that way, or the browser bundle breaks.
 *
 * All three redact decrypted secret values out of third-party process output
 * before it reaches a log line, an HTTP body, or a durable column
 * (`web_sessions.last_error`, `eval_jobs.error`). They were three separate
 * implementations covering different encodings, which meant each one's backstop
 * was weaker than the layer it was backstopping. One definition here instead.
 *
 * Dependency-free on purpose: Core imports it via `@shared/credentials`, and
 * the daemon and broker via `../shared/credentials` with a matching Dockerfile
 * COPY, the same arrangement `shared/secrets.ts` already uses.
 */

/**
 * Percent-encoded spellings of `v`, best-effort.
 *
 * A failed login is reported with the URL the browser ended on, and SSO
 * redirects carry the account in a query param (`login_hint=a%40b.com`), so the
 * raw value never appears there. Both hex casings are emitted: encodeURIComponent
 * produces uppercase, but a URL echoed back from a target site may have written
 * it lowercase, and the needle has to match the text as it was written.
 *
 * Returns [] rather than throwing. encodeURIComponent throws URIError on an
 * unpaired surrogate, and `"\ud800"` is legal JSON, so such a value really does
 * arrive from a request body. On the broker both call sites are inside
 * child-process handlers where the promise executor has already returned, so a
 * throw there is an uncaught exception that takes the process down.
 */
export function urlForms(v: string): string[] {
  let enc: string;
  try {
    enc = encodeURIComponent(v);
  } catch {
    return []; // lone surrogate
  }
  const lower = enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  // application/x-www-form-urlencoded differs only in spaces (+ vs %20).
  return [enc, enc.replace(/%20/g, "+"), lower, lower.replace(/%20/gi, "+")];
}

/**
 * Every spelling a credential can take in third-party output, so a redaction
 * can match it: raw, the JSON/YAML double-quoted scalar it is embedded as, and
 * the URL encodings above.
 *
 * The escaped form is derived from the SAME `JSON.stringify` that writes the
 * scenario YAML rather than a hand-rolled escaper, so the two cannot drift:
 * whatever the emitter produces is, by construction, what gets redacted.
 * Callers whose emitter escapes differently (the daemon substitutes via its own
 * `yamlEscape`) should add that spelling rather than assume this one covers it.
 */
export function credentialForms(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((v) => v.length > 0)
        .flatMap((v) => [v, JSON.stringify(v).slice(1, -1), ...urlForms(v)]),
    ),
  );
}

/**
 * Replace every occurrence of each value with `[redacted]`.
 *
 * Longest first, which is load-bearing when one value contains another: with
 * password "brent@agora.op-2026!" and email "brent@agora.op", redacting the
 * email first destroys the password's only occurrence and leaks the "-2026!"
 * remainder. Replacing the longest needle first makes whole values win over
 * their substrings.
 *
 * Empty values are dropped — `"".split("")` splits between every character and
 * would replace the entire message with separators.
 */
export function redactValues(message: string, values: string[]): string {
  return values
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((acc, v) => acc.split(v).join("[redacted]"), message);
}

/**
 * A comparison fingerprint for a credential: its length and a truncated MD5.
 *
 * Exists because diagnosing a failed login means answering "is the value we
 * stored the same one that works?", and the only way to answer it so far was
 * decrypting the secret inside a production container. The owner can now
 * compare against their own copy in one line:
 *
 *   printf %s 'the-password' | md5sum | cut -c1-10
 *
 * (`printf %s`, not `echo` — a trailing newline changes the hash.)
 *
 * MD5 and a 10-hex-digit prefix are deliberate. This is a comparison aid, not
 * a security primitive: it must be reproducible with tools an operator already
 * has, so a keyed or salted hash would defeat the entire purpose. That choice
 * is exactly why WHERE a fingerprint may appear is constrained — see
 * fingerprintForLog below. Length is included because it is often enough on its
 * own: a password that changed from 20 characters to 16 is visibly a different
 * value without any hash at all.
 */
export interface CredentialFingerprint {
  length: number;
  md5_10: string;
}

export function fingerprintCredential(value: string): CredentialFingerprint {
  return { length: value.length, md5_10: md5Prefix(value) };
}

/**
 * What may be written to a LOG, as opposed to shown to an authenticated owner.
 *
 * The distinction is not fussiness. Container logs are shipped to aggregators,
 * screen-shared, and pasted into chat threads; an unsalted MD5 plus an exact
 * length is a practical cracking aid for a weak password. So:
 *
 *  - identifiers (an email) get a full fingerprint — the value is already
 *    visible in aeval's own masked output and in its error screenshots, so the
 *    hash adds diagnostic power without adding meaningful exposure;
 *  - secrets (a password) get their LENGTH only, which still catches the common
 *    "wrong value stored" case, without publishing a hash to crack.
 *
 * The password's full fingerprint is available to its owner in the console,
 * behind authentication, where it is their own credential.
 */
export function fingerprintForLog(identifier: string, secret: string): string {
  const id = fingerprintCredential(identifier);
  return `identifier len=${id.length} md5=${id.md5_10}, secret len=${secret.length}`;
}

function md5Prefix(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex").slice(0, 10);
}

/**
 * The "last failed request HTTP NNN" marker, formatted in the broker and parsed
 * back out in Core.
 *
 * One definition because the two live in different packages and communicate
 * through a formatted string: the broker builds the mint error, Core extracts
 * the status from `webSessions.lastError` to give a non-owner agent the code
 * without the prose. Two hand-written regexes would drift silently — the status
 * would simply vanish from the 503 body with nothing going red, which is the
 * "looks wired but isn't" failure this codebase has already produced once.
 */
const LAST_FAILED_HTTP = /\(last failed request HTTP (\d{3})\)/;

export function formatLastFailedHttpStatus(status: number): string {
  return ` (last failed request HTTP ${status})`;
}

export function parseLastFailedHttpStatus(message: string): number | null {
  const m = LAST_FAILED_HTTP.exec(message);
  return m ? Number(m[1]) : null;
}
