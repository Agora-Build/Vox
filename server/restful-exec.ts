// Template resolution for the trusted restful.* path (design 2026-09-21 §5).
// Pure: takes the FROZEN trigger template (from the job snapshot), the decrypted
// secret map for the workflow-ownership scope, and the caller-suppliable
// variable whitelist. Produces the concrete RestExecRequest plus the list of
// secret VALUES that were interpolated (the redaction needles for everything
// later returned to an agent). Never performs IO.
import type { RestfulTrigger } from "@shared/schema";
import type { RestExecRequest } from "./broker-registry";

const SECRET_REF = /\$\{secrets\.([A-Za-z0-9_]+)\}/g;
const PHONE_REF = "${phoneNumber}";

export type ResolveResult =
  | { ok: true; request: RestExecRequest; usedSecretValues: string[] }
  | { ok: false; error: string };

export function resolveRestfulTemplate(
  trigger: RestfulTrigger,
  secrets: Record<string, string>,
  variables: { phoneNumber?: string },
): ResolveResult {
  const used = new Set<string>();
  let failure: string | null = null;

  const resolveString = (s: string): string => {
    let out = s;
    if (out.includes(PHONE_REF)) {
      if (variables.phoneNumber === undefined) {
        failure = failure ?? "template references ${phoneNumber} but no phoneNumber variable was provided";
        return out;
      }
      out = out.split(PHONE_REF).join(variables.phoneNumber);
    }
    out = out.replace(SECRET_REF, (_m, name: string) => {
      const v = secrets[name];
      if (v === undefined) {
        // Name only — never a value — in the error (it may reach the daemon log).
        failure = failure ?? `unresolved secret reference: ${name}`;
        return _m;
      }
      used.add(v);
      return v;
    });
    return out;
  };

  const resolveDeep = (node: unknown): unknown => {
    if (typeof node === "string") return resolveString(node);
    if (Array.isArray(node)) return node.map(resolveDeep);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = resolveDeep(v);
      return out;
    }
    return node;
  };

  const url = resolveString(trigger.url);
  const headers = trigger.headers
    ? Object.fromEntries(Object.entries(trigger.headers).map(([k, v]) => [k, resolveString(v)]))
    : undefined;
  const body = trigger.body !== undefined ? resolveDeep(trigger.body) : undefined;

  if (failure) return { ok: false, error: failure };
  return {
    ok: true,
    request: {
      method: trigger.method,
      url,
      headers,
      body,
      expectStatus: trigger.expectStatus,
      timeoutMs: trigger.timeoutMs,
    },
    usedSecretValues: Array.from(used),
  };
}
