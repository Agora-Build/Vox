import yaml from "js-yaml";
import { fillJobPlaceholders, jobConfigVars } from "./placeholders";
import { acceptsAccountStorage } from "./account-session-protocol";

export interface AccountSetup {
  platformId: string;
  emailSecret: string;
  passwordSecret: string;
}

// These scopes mirror reviewed engine provider definitions, not uploaded state.
// New providers require an explicit profile and restore/checkpoint qualification.
const profiles: Readonly<Record<string, { tenant: string; cookieDomains: string[]; storageOrigins: string[] }>> = {
  elevenlabs: { tenant: "https://elevenlabs.io", cookieDomains: ["elevenlabs.io", ".elevenlabs.io"], storageOrigins: ["https://elevenlabs.io"] },
};

export function accountProvider(platformId: string) {
  return Object.hasOwn(profiles, platformId) ? profiles[platformId] : null;
}

export function acceptsProviderAccountState(platformId: string, state: unknown): boolean {
  const profile = accountProvider(platformId);
  return !!profile && acceptsAccountStorage(state, profile);
}

/** Frozen job config, expanded identically to the agent but without secret values. */
export function accountSetupForJob(config: Record<string, unknown>, brokered = false): AccountSetup | null {
  try {
    const parse = (v: unknown) => typeof v === "string" && v.trim() ? yaml.load(v) : undefined;
    const { parts } = fillJobPlaceholders({ scenario: parse(config.scenario), stepsPrefix: parse(config.stepsPrefix),
      stepsSuffix: parse(config.stepsSuffix) }, jobConfigVars(config), {}, { evalSetSecrets: config.evalSetSecrets === true });
    const body = parts.scenario as { steps?: unknown[] } | undefined;
    const steps = [...(Array.isArray(parts.stepsPrefix) ? parts.stepsPrefix : []), ...(Array.isArray(body?.steps) ? body.steps : []),
      ...(Array.isArray(parts.stepsSuffix) ? parts.stepsSuffix : [])] as Array<{ type?: string; platform_id?: string; mode?: string; params?: Record<string, unknown> }>;
    const setups = steps.filter(s => s?.type === "platform.setup");
    if (setups.length !== 1) return null;
    const step = setups[0], params = step.params ?? {};
    if (!accountProvider(step.platform_id ?? "") || (params.mode ?? step.mode) !== "account" ||
        (!brokered && (typeof params.storage_file !== "string" || !params.storage_file.trim()))) return null;
    const ref = (v: unknown) => typeof v === "string" ? /^\$\{secrets\.([A-Za-z0-9_]+)\}$/.exec(v)?.[1] : undefined;
    const emailSecret = ref(params.email), passwordSecret = ref(params.password);
    return emailSecret && passwordSecret ? { platformId: step.platform_id!, emailSecret, passwordSecret } : null;
  } catch { return null; }
}
