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
 * Matched on UNDERSCORE-DELIMITED TOKENS, not as substrings. Secret names are
 * validated as UPPER_SNAKE (SECRET_NAME_PATTERN above), so a token boundary is
 * exactly the right unit and there is no camelCase blind spot. Substring
 * matching is what made the two old copies wrong in opposite directions: the
 * console's bare `NAME` classified APP_NAME / CHANNEL_NAME as logins, and bare
 * `USER` would classify USER_AGENT, USER_ID and SUPERUSER_KEY the same way.
 * Neither token appears below — USERNAME is matched directly, which is all
 * either was ever reaching for.
 */
export const AUTH_FIELD_NAME_PATTERN = /(?:^|_)(?:USERNAME|PASSWORD|ACCOUNT|EMAIL)(?:_|$)/i;

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
