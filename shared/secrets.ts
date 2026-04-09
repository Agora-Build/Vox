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
