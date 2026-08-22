import { describe, it, expect } from "vitest";
import { deriveApiKeyStatus } from "../server/api-key-status";

describe("deriveApiKeyStatus", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const past = new Date("2026-08-21T00:00:00.000Z");
  const future = new Date("2026-08-23T00:00:00.000Z");

  it("revoked wins regardless of expiresAt (past)", () => {
    expect(deriveApiKeyStatus({ isRevoked: true, expiresAt: past }, now)).toBe("revoked");
  });

  it("revoked wins regardless of expiresAt (future)", () => {
    expect(deriveApiKeyStatus({ isRevoked: true, expiresAt: future }, now)).toBe("revoked");
  });

  it("revoked wins with null expiresAt", () => {
    expect(deriveApiKeyStatus({ isRevoked: true, expiresAt: null }, now)).toBe("revoked");
  });

  it("expired when not revoked and expiresAt is in the past", () => {
    expect(deriveApiKeyStatus({ isRevoked: false, expiresAt: past }, now)).toBe("expired");
  });

  it("active when not revoked and expiresAt is in the future", () => {
    expect(deriveApiKeyStatus({ isRevoked: false, expiresAt: future }, now)).toBe("active");
  });

  it("active when not revoked and expiresAt is null (never expires)", () => {
    expect(deriveApiKeyStatus({ isRevoked: false, expiresAt: null }, now)).toBe("active");
  });

  it("expiresAt exactly equal to now is not yet expired (active)", () => {
    expect(deriveApiKeyStatus({ isRevoked: false, expiresAt: now }, now)).toBe("active");
  });

  it("accepts an ISO string expiresAt (past → expired)", () => {
    expect(deriveApiKeyStatus({ isRevoked: false, expiresAt: past.toISOString() }, now)).toBe("expired");
  });

  it("defaults now to current time when omitted (revoked path is time-independent)", () => {
    expect(deriveApiKeyStatus({ isRevoked: true, expiresAt: null })).toBe("revoked");
  });
});
