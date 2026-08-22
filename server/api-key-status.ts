// Derived API-key lifecycle status — computed on read, never stored as a column.
// Precedence: revoked wins over everything; else expired if past its expiry; else active.

export type ApiKeyStatus = "active" | "expired" | "revoked";

export function deriveApiKeyStatus(
  key: { isRevoked: boolean; expiresAt: Date | string | null },
  now: Date = new Date(),
): ApiKeyStatus {
  if (key.isRevoked) return "revoked";
  if (key.expiresAt != null) {
    const exp = key.expiresAt instanceof Date ? key.expiresAt : new Date(key.expiresAt);
    if (exp.getTime() < now.getTime()) return "expired";
  }
  return "active";
}
