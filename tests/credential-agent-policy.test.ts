import { describe, expect, it } from "vitest";
import { credentialAgentViolation, credentialPoolViolation, ownsCredentialScope } from "../server/credential-policy";

const personal = { ownerId: 1, organizationId: null };
const organization = { ownerId: 1, organizationId: 10 };
const agent = (dispatchTier: string, createdBy = 1, organizationId: number | null = 10) => ({ dispatchTier, createdBy, organizationId });

describe("credential agent policy", () => {
  it.each([true, false])("allows authorized Mainline delivery (runtime=%s)", (runtime) => {
    expect(credentialAgentViolation(personal, agent("public", 99), runtime)).toBeNull();
    expect(credentialAgentViolation(organization, agent("public", 99), runtime)).toBeNull();
  });
  it("allows own personal credentials on own Shared agents, but requires Brokered for others", () => {
    expect(credentialAgentViolation(personal, agent("shared"), true)).toBeNull();
    expect(credentialAgentViolation(personal, agent("shared"), false)).toBeNull();
    expect(credentialAgentViolation(organization, agent("shared"), true)).toMatch(/Brokered/);
    expect(credentialAgentViolation(personal, agent("shared", 99), true)).toMatch(/Brokered/);
    expect(credentialAgentViolation(personal, agent("shared", 99), false)).toBeNull();
  });
  it.each([true, false])("Private accepts only that operator's personal credentials (runtime=%s)", (runtime) => {
    expect(credentialAgentViolation(personal, agent("private"), runtime)).toBeNull();
    expect(credentialAgentViolation(personal, agent("private", 2), true)).toMatch(/owner/);
    expect(credentialAgentViolation(organization, agent("private"), true)).toMatch(/Team/);
  });
  it("Team accepts only same-organization credentials, including for sessions", () => {
    expect(credentialAgentViolation(organization, agent("team", 2), true)).toBeNull();
    expect(credentialAgentViolation(organization, agent("team", 2), false)).toBeNull();
    expect(credentialAgentViolation(personal, agent("team"), true)).toMatch(/never personal/);
    expect(credentialAgentViolation(organization, agent("team", 2, 20), true)).toMatch(/organization/);
    expect(credentialAgentViolation(organization, agent("team", 2, null), true)).toMatch(/organization/);
  });
  it("unknown tiers fail closed", () => {
    expect(credentialAgentViolation(personal, agent("future"), false)).toBeTruthy();
  });
  it("pooled Mainline sessions are permitted, including the owner's schedules", () => {
    expect(credentialPoolViolation("public", personal, { id: 1, organizationId: null })).toBeNull();
  });
  it("personal and organization ownership cannot be interchanged", () => {
    expect(ownsCredentialScope(personal, { id: 1, organizationId: 10 })).toBe(true);
    expect(ownsCredentialScope(personal, { id: 2, organizationId: 10 })).toBe(false);
    expect(ownsCredentialScope(organization, { id: 2, organizationId: 10 })).toBe(true);
    expect(ownsCredentialScope(organization, { id: 1, organizationId: null })).toBe(false);
  });
});
