import { describe, it, expect } from "vitest";
import { resolveTargetedDispatch } from "../server/dispatch";

const user = { id: 1, organizationId: 10 };
const owner = { organizationId: 10 };
const base = { id: 50, createdBy: 2, region: "apac-in-mumbai-01" };

describe("resolveTargetedDispatch", () => {
  it("public token: ok, region derived from token", () => {
    const d = resolveTargetedDispatch(user, { ...base, dispatchTier: "public" }, owner);
    expect(d).toEqual({ ok: true, region: "apac-in-mumbai-01" });
  });
  it("team token, same org: ok", () => {
    const d = resolveTargetedDispatch(user, { ...base, dispatchTier: "team" }, owner);
    expect(d.ok).toBe(true);
    expect(d.region).toBe("apac-in-mumbai-01");
  });
  it("private token, not owner: forbidden", () => {
    const d = resolveTargetedDispatch(user, { ...base, dispatchTier: "private" }, owner);
    expect(d).toEqual({ ok: false, reason: "forbidden" });
  });
  it("shared token: deferred to the seam", () => {
    const d = resolveTargetedDispatch(user, { ...base, dispatchTier: "shared" }, owner);
    expect(d).toEqual({ ok: false, reason: "shared-requires-marketplace" });
  });
});
