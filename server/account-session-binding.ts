import { createHash } from "node:crypto";

export type AccountSessionScope = { userId: number } | { organizationId: number };
export type AccountSessionSource = "runtime" | "brokered";

export interface AccountSessionCredential {
  id: number;
  name: string;
  encryptedValue: string;
  brokerType: string | null;
  userId?: number;
  organizationId?: number;
}

export interface AccountSessionBinding {
  readonly sessionKey: string;
  readonly userId: number | null;
  readonly organizationId: number | null;
  readonly source: AccountSessionSource;
  readonly platformId: string;
  readonly tenantKey: string;
  readonly credentialRevision: string;
}

export class AccountSessionError extends Error {
  constructor(public readonly code: "invalid-binding" | "unauthorized" | "invalid-state" | "state-unavailable" | "invalid-checkpoint") {
    super(`Account session: ${code}`);
    this.name = "AccountSessionError";
  }
}

export function sessionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;

/** Core-only inputs: frozen ownership, current ciphertext rows and reviewed provider binding. */
export function accountSessionBinding(input: {
  scope: AccountSessionScope;
  source: AccountSessionSource;
  platformId: string;
  tenantBinding: string;
  email: AccountSessionCredential;
  password: AccountSessionCredential;
}): AccountSessionBinding {
  const invalid = () => { throw new AccountSessionError("invalid-binding"); };
  const scope = input.scope as { userId?: number; organizationId?: number };
  const userId = scope.userId ?? null;
  const organizationId = scope.organizationId ?? null;
  if ((userId === null) === (organizationId === null) ||
      (userId !== null && !positiveId(userId)) || (organizationId !== null && !positiveId(organizationId))) invalid();
  if (!["runtime", "brokered"].includes(input.source) ||
      typeof input.platformId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.platformId) ||
      typeof input.tenantBinding !== "string" || !input.tenantBinding || input.tenantBinding.length > 4096) invalid();

  const expectedBroker = input.source === "brokered" ? "auth-session" : null;
  for (const row of [input.email, input.password]) {
    if (!positiveId(row.id) || typeof row.name !== "string" || !row.name ||
        typeof row.encryptedValue !== "string" || !row.encryptedValue || row.brokerType !== expectedBroker ||
        (row.userId ?? null) !== userId || (row.organizationId ?? null) !== organizationId) invalid();
  }
  if (input.email.id === input.password.id) invalid();

  // Hash randomized ciphertext, never low-entropy plaintext credentials. Replacing
  // or deleting/recreating either secret changes the binding even under the same name.
  const credentialRevision = sessionDigest([input.email, input.password].map(row =>
    [row.id, row.name, row.brokerType, row.encryptedValue]));
  const tenantKey = sessionDigest(input.tenantBinding);
  const fields = { userId, organizationId, source: input.source, platformId: input.platformId, tenantKey, credentialRevision };
  return Object.freeze({ ...fields, sessionKey: sessionDigest(["account-session-v1", fields]) });
}
