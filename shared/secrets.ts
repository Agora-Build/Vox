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
 * Matched at the END of a token, never as a bare substring, and with a
 * deliberately narrow USER arm. Secret names are validated UPPER_SNAKE
 * (SECRET_NAME_PATTERN above), so `_`/end is the right unit and there is no
 * camelCase blind spot.
 *
 * The two failure directions are NOT symmetric, and both are worse than they
 * first look:
 *
 *  - A false POSITIVE does not merely withhold the secret from the agent. Two
 *    brokered secrets that are not the workflow's platform.setup login pair are
 *    caught by findBrokeredMisuse, and the run route rejects the ENTIRE
 *    workflow. So DB_USER + DB_PASSWORD defaulting to brokered would leave a
 *    user with a workflow that cannot run at all. That is why the USER arm
 *    lists login-ish prefixes rather than accepting any `*_USER`:
 *    DB_USER / SMTP_USER / POSTGRES_USER are far more common in a secrets store
 *    than API_USER, and USER_AGENT / USER_ID / MAX_USERS must not match either.
 *  - A false NEGATIVE defaults a credential to the runtime class, which IS the
 *    agent-exposed one, and it fails SILENTLY: if both halves of a pair miss,
 *    evaluateSessionRequirement returns "none" and takes the runtime path with
 *    no misconfiguration error to notice.
 *
 * Hence: `\d*` for second-account names (PASSWORD2), a plural `S` only at the
 * END (SUPPORT_EMAILS, LOGIN_PASSWORDS — but NOT ACCOUNTS_URL or MAX_USERS,
 * where the plural is followed by more name), and `USER_?NAME` for both
 * spellings of that field without letting bare NAME back in to catch APP_NAME.
 *
 * Known residual, and a NARROWING versus the old server-side substring regex:
 * an unseparated trailing word (EMAILADDRESS, ACCOUNTNAME, PASSWORDHASH) used
 * to match and no longer does. Rare under the UPPER_SNAKE convention, and
 * admitting it means returning to substrings, which re-admits USER_AGENT and
 * EMAILER_API_KEY.
 */
export const AUTH_FIELD_NAME_PATTERN =
  /(?:USER_?NAME|PASSWORD|ACCOUNT|EMAIL)\d*(?:S$|_|$)|(?:^|_)(?:LOGIN|ACCOUNT|CONSOLE|WEB|PORTAL|SIGNIN)_USER\d*$|^USER\d*$/i;

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
