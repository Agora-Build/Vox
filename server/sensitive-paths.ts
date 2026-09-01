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
 * The test beside this file SCANS server/routes.ts and asserts that every
 * handler returning a plaintext credential resolves sensitive — it does not
 * merely re-list what is here, because a hand-written list cannot detect the
 * route nobody added to either file. That is not hypothetical: it is how
 * /api/eval-agent-tokens and /api/admin/users/:id/activation-link stayed
 * missing while the suite was green.
 */
export const SENSITIVE_PATHS = new Set([
  "/api/user/api-keys",
  "/api/admin/eval-agent-tokens",
  "/api/admin/invite",
  "/api/secrets",                // returns valueFingerprint to the owner
  "/api/org-secrets",            // sibling path: NOT covered by the entry above
  "/api/eval-agent-tokens",      // POST returns the agent token in plaintext, once
  "/api/admin/broker-tokens",    // POST returns the registration token, once
  "/api/brokers/register",       // returns the per-broker mintSecret, once
  // These three carry the credential in a LATER path segment, so a prefix is
  // the only way to reach them. Deliberately broad: redacting a response body
  // costs log detail, whereas an activation link or an org invite recovered
  // from a log is account takeover.
  "/api/admin/users",            // /:id/activation-link returns token + activationUrl
  "/api/organizations",          // /:id/invite returns the invite token
  "/api/clash/matches",          // /:id/stream-info returns a spectator RTC token
  "/api/clash/moderator",        // /start returns the moderator's RTC token
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
