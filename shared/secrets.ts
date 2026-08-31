/**
 * Secret name validation and placeholder resolution utilities.
 *
 * Single source of truth for the secret naming convention.
 * Used by: server (validation), tests, eval agentd, clash runner.
 *
 * Standalone packages (vox_eval_agentd, vox_clash_runner) duplicate the
 * regex inline because they are bundled independently — keep them aligned
 * with this file.
 */

/** Regex for valid secret names: uppercase letters, digits, underscores. Must start with a letter. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Regex for finding ${secrets.KEY} placeholders in strings. */
export const SECRET_PLACEHOLDER_REGEX = /\$\{secrets\.([A-Z][A-Z0-9_]*)\}/g;

/**
 * Names that read like a web-login credential, and so should DEFAULT to a
 * brokered (login-class) secret rather than a runtime one.
 *
 * Lives here, not in server/ or in the console, because both sides pre-select
 * the same toggle and MUST agree. When they drifted, the console defaulted
 * `AGORA_CONSOLE_EMAIL` to the auth-session broker but left
 * `AGORA_CONSOLE_PASSWORD` on Runtime — and a split pair is rejected outright
 * by evaluateSessionRequirement ("Login requires BOTH email and password to be
 * dedicated login-class secrets"), so the UI's own default produced a workflow
 * that could never run.
 *
 * This is only a DEFAULT; both the console dropdown and the API's explicit
 * `brokerType` override it. It is deliberately a small, boring list — a false
 * positive marks a runtime secret Core-only and withholds it from the agent,
 * which breaks a working run.
 *
 * Anchored at the END of a token rather than matched as a bare substring, with
 * an optional digit suffix. Secret names are validated UPPER_SNAKE
 * (SECRET_NAME_PATTERN above), so `_`/end is the right unit and there is no
 * camelCase blind spot.
 *
 * The two failure directions are NOT symmetric, and the anchoring is chosen for
 * that:
 *  - A false POSITIVE breaks availability — Core marks the secret login-class
 *    and withholds it from the agent, so a working run starts failing. Plain
 *    substring matching caused this in both old copies: the console's bare
 *    `NAME` swept up APP_NAME / CHANNEL_NAME, and a bare `USER` would sweep up
 *    USER_AGENT, USER_ID, SUPERUSER_KEY. Both tokens are therefore absent;
 *    USERNAME is matched directly, which is all either was reaching for.
 *  - A false NEGATIVE is worse HERE: it defaults a credential to the runtime
 *    class, which IS the agent-exposed one, and it fails SILENTLY — if both
 *    halves miss, evaluateSessionRequirement returns "none" and takes the
 *    runtime path with no misconfiguration error to notice. So the trailing
 *    `\d*S?` is not cosmetic: PASSWORD2 and EMAIL2 are ordinary
 *    second-test-account names, and SUPPORT_EMAILS / LOGIN_PASSWORDS are
 *    ordinary plurals, all of which a bare boundary would ship to an agent.
 *    Residual: a trailing WORD still misses (EMAILADDRESS, ACCOUNTNAME).
 *    Admitting those means going back to substrings, which re-admits
 *    USER_AGENT and EMAILER_API_KEY — so they stay out deliberately.
 *
 * Leaving off a leading `(?:^|_)` is deliberate for the same reason: MYPASSWORD
 * and AGORAEMAIL end in a credential word and must match, while EMAILER_API_KEY
 * (EMAIL followed by a letter) still does not.
 *
 * The USER family needs its own arm. A bare `USER` token would sweep up
 * USER_AGENT, USER_ID, CURRENT_USER_ID and SUPERUSER_KEY — ordinary runtime
 * values — so it is anchored to the END of the name: LOGIN_USER and API_USER
 * are identifiers paired with a password, while USER_AGENT is not. `USER_?NAME`
 * covers both spellings of the same field without letting bare NAME back in to
 * catch APP_NAME. Without this arm, LOGIN_USER + LOGIN_PASSWORD still split —
 * the exact bug this file exists to fix, one name-shape over.
 */
export const AUTH_FIELD_NAME_PATTERN =
  /(?:USER_?NAME|PASSWORD|ACCOUNT|EMAIL)\d*S?(?:_|$)|(?:^|_)USER\d*S?$/i;

/** True when a secret name reads like a login credential. See the pattern above. */
export function isAuthFieldName(name: string): boolean {
  return AUTH_FIELD_NAME_PATTERN.test(name);
}

/**
 * Resolve ${secrets.KEY} placeholders in a string.
 * Unresolved placeholders are left as-is.
 */
export function resolveSecretPlaceholders(
  content: string,
  secrets: Record<string, string>,
  onMissing?: (key: string) => void,
): string {
  return content.replace(SECRET_PLACEHOLDER_REGEX, (match, key) => {
    if (key in secrets) return secrets[key];
    onMissing?.(key);
    return match;
  });
}

/**
 * Enumerate every ${secrets.NAME} referenced across one or more configs.
 * Objects (jsonb workflow/eval-set configs) are JSON-stringified before
 * scanning — $ { } . are all JSON-safe inside a string, so the placeholder
 * regex still matches. A fresh RegExp per config avoids shared-lastIndex bugs
 * with the module-level global regex.
 */
export function collectSecretRefs(configs: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const cfg of configs) {
    if (cfg == null) continue;
    const text = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
    const re = new RegExp(SECRET_PLACEHOLDER_REGEX.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
  }
  return names;
}
