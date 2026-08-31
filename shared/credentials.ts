/**
 * Credential redaction primitives, shared by Core, the eval-agent daemon and
 * the auth-session broker.
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
