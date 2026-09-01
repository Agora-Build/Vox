/**
 * Routes whose RESPONSE BODY must never reach the request log.
 *
 * Its own module, not a const inside `index.ts`, so a test can import it
 * without booting the server — a list like this is worthless if nothing checks
 * it, and it has already failed once: `/api/org-secrets` was missing while
 * `/api/secrets` was present, so adding credential fingerprints to both routes
 * gated one at the route level and then wrote the other straight into the
 * container log. The route gate was real; the logger undid it one layer up.
 *
 * Matching is exact OR by prefix, so `/api/secrets` also covers
 * `/api/secrets/:name`. Note that prefix matching does NOT relate
 * `/api/org-secrets` to `/api/secrets` — they are separate entries on purpose.
 *
 * The test beside this file asserts that every route returning a credential is
 * listed. Add the entry in the SAME commit as any such route: a one-time
 * plaintext token is exactly the thing that must not be recoverable from a log
 * afterwards, and nothing else in the codebase will catch the omission.
 */
export const SENSITIVE_PATHS = new Set([
  "/api/user/api-keys",
  "/api/admin/eval-agent-tokens",
  "/api/admin/invite",
  "/api/secrets",
  "/api/org-secrets",            // returns valueFingerprint for org managers
  "/api/admin/broker-tokens",    // POST returns the registration token in plaintext, once
  "/api/brokers/register",       // returns the per-broker mintSecret, once
  "/api/eval-agent/jobs",        // /jobs/:id/secrets matched by startsWith
  "/api/clash-runner/secrets",
  "/api/admin/clash-runner-tokens",
]);

// Hoisted: this runs on every /api request.
const SENSITIVE_PREFIXES = Array.from(SENSITIVE_PATHS);

export function isSensitiveResponsePath(path: string): boolean {
  if (SENSITIVE_PATHS.has(path)) return true;
  return SENSITIVE_PREFIXES.some((p) => path.startsWith(p));
}
