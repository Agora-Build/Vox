import { describe, expect, it } from "vitest";
import { accountSessionBinding, type AccountSessionCredential } from "../server/account-session-binding";

const email: AccountSessionCredential = { id: 1, userId: 7, name: "EMAIL", encryptedValue: "v1:random-email-ciphertext", brokerType: null };
const password: AccountSessionCredential = { id: 2, userId: 7, name: "PASSWORD", encryptedValue: "v1:random-password-ciphertext", brokerType: null };
const input = { scope: { userId: 7 }, source: "runtime" as const, platformId: "elevenlabs", tenantBinding: "approved-tenant", email, password };

describe("Core account-session bindings", () => {
  it("is deterministic, immutable and contains no secret material", () => {
    const binding = accountSessionBinding(input);
    expect(binding).toEqual(accountSessionBinding({ ...input, email: { ...email }, password: { ...password } }));
    expect(binding.sessionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(JSON.stringify(binding)).not.toContain("ciphertext");
    expect(JSON.stringify(binding)).not.toContain("approved-tenant");
  });

  it("does not share a key across owner, organization, source, provider or tenant", () => {
    const variants = [
      input,
      { ...input, scope: { userId: 8 }, email: { ...email, userId: 8 }, password: { ...password, userId: 8 } },
      { ...input, scope: { organizationId: 7 }, email: { ...email, userId: undefined, organizationId: 7 }, password: { ...password, userId: undefined, organizationId: 7 } },
      { ...input, source: "brokered" as const, email: { ...email, brokerType: "auth-session" }, password: { ...password, brokerType: "auth-session" } },
      { ...input, platformId: "synthetic_provider" },
      { ...input, tenantBinding: "another-approved-tenant" },
    ];
    expect(new Set(variants.map(value => accountSessionBinding(value).sessionKey)).size).toBe(variants.length);
  });

  it.each(["email", "password"] as const)("invalidates when %s is changed or recreated under the same name", (field) => {
    const original = accountSessionBinding(input);
    const row = input[field];
    for (const replacement of [{ ...row, encryptedValue: "v1:rotated-ciphertext" }, { ...row, id: row.id + 10 }]) {
      const next = accountSessionBinding({ ...input, [field]: replacement });
      expect(next.credentialRevision).not.toBe(original.credentialRevision);
      expect(next.sessionKey).not.toBe(original.sessionKey);
    }
  });

  it("does not use property order or unrelated legacy metadata as a revision", () => {
    const reordered = { brokerType: null, encryptedValue: email.encryptedValue, name: email.name, userId: 7, id: 1 };
    expect(accountSessionBinding({ ...input, email: reordered })).toEqual(accountSessionBinding(input));
  });

  it.each([
    { scope: { userId: 0 } }, { scope: { userId: 7, organizationId: 7 } }, { scope: {} },
    { scope: { userId: 7.5 } }, { tenantBinding: "" }, { platformId: "../provider" },
    { email: { ...email, userId: 8 } }, { password: { ...password, organizationId: 7 } },
    { password: { ...password, id: email.id } }, { email: { ...email, encryptedValue: "" } },
    { email: { ...email, brokerType: "auth-session" } },
    { source: "brokered" }, { source: "restful" },
  ])("fails closed on invalid/mixed credential bindings: %j", (patch) => {
    expect(() => accountSessionBinding({ ...input, ...patch } as typeof input)).toThrow("Account session: invalid-binding");
  });
});

