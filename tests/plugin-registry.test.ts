import { describe, it, expect } from "vitest";
import { ServiceRegistry } from "../server/plugins/registry";

describe("ServiceRegistry", () => {
  it("resolves a required service by semver range", () => {
    const r = new ServiceRegistry();
    r.provide("vox.sample", "1.2.0", { hi: () => "yo" });
    const svc = r.require<{ hi: () => string }>("vox.sample", "^1");
    expect(svc.hi()).toBe("yo");
  });

  it("returns null for an absent optional service", () => {
    const r = new ServiceRegistry();
    expect(r.optional("vox.missing", "^1")).toBeNull();
  });

  it("throws for an absent required service", () => {
    const r = new ServiceRegistry();
    expect(() => r.require("vox.missing", "^1")).toThrow(/not available/);
  });

  it("throws on a duplicate singleton provider", () => {
    const r = new ServiceRegistry();
    r.provide("vox.sample", "1.0.0", {});
    expect(() => r.provide("vox.sample", "1.1.0", {})).toThrow(/duplicate/);
  });

  it("throws when the present provider version does not satisfy the range", () => {
    const r = new ServiceRegistry();
    r.provide("vox.sample", "2.0.0", {});
    expect(() => r.require("vox.sample", "^1")).toThrow(/does not satisfy/);
    expect(() => r.optional("vox.sample", "^1")).toThrow(/does not satisfy/);
  });
});
