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
 */
export const SENSITIVE_PATHS = new Set([
  "/api/user/api-keys",
  "/api/admin/eval-agent-tokens",
  "/api/admin/invite",
  "/api/secrets",
  "/api/org-secrets",            // returns valueFingerprint for org managers
  "/api/eval-agent/jobs",        // /jobs/:id/secrets matched by startsWith
  "/api/clash-runner/secrets",
  "/api/admin/clash-runner-tokens",
]);

export function isSensitiveResponsePath(path: string): boolean {
  if (SENSITIVE_PATHS.has(path)) return true;
  return Array.from(SENSITIVE_PATHS).some((p) => path.startsWith(p));
}
