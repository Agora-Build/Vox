import { describe, it, expect } from "vitest";
import { resolveActivationOrder } from "../server/plugins/resolve";
import type { PluginManifest } from "../server/plugins/manifest";

function mf(over: Partial<PluginManifest> & { id: string }): PluginManifest {
  return {
    version: "1.0.0", voxPluginApi: "^1.0.0",
    providesServices: {}, requiresServices: {}, optionalServices: {}, routes: [],
    ...over,
  };
}

describe("resolveActivationOrder", () => {
  it("orders providers before consumers", () => {
    const consumer = mf({ id: "consumer", requiresServices: { "vox.credits": "^1" } });
    const provider = mf({ id: "credits", providesServices: { "vox.credits": "1.0.0" } });
    const order = resolveActivationOrder([consumer, provider]).map((m) => m.id);
    expect(order.indexOf("credits")).toBeLessThan(order.indexOf("consumer"));
  });

  it("throws when a required service has no provider", () => {
    const consumer = mf({ id: "consumer", requiresServices: { "vox.credits": "^1" } });
    expect(() => resolveActivationOrder([consumer])).toThrow(/no enabled plugin provides/);
  });

  it("throws on a duplicate singleton provider", () => {
    const a = mf({ id: "a", providesServices: { "vox.credits": "1.0.0" } });
    const b = mf({ id: "b", providesServices: { "vox.credits": "1.0.0" } });
    expect(() => resolveActivationOrder([a, b])).toThrow(/duplicate singleton provider/);
  });

  it("throws on a dependency cycle", () => {
    const a = mf({ id: "a", providesServices: { "svc.a": "1.0.0" }, requiresServices: { "svc.b": "^1" } });
    const b = mf({ id: "b", providesServices: { "svc.b": "1.0.0" }, requiresServices: { "svc.a": "^1" } });
    expect(() => resolveActivationOrder([a, b])).toThrow(/cycle/);
  });

  it("orders after an optional provider when present, without requiring it", () => {
    const consumer = mf({ id: "consumer", optionalServices: { "vox.orgs": "^1" } });
    const provider = mf({ id: "orgs", providesServices: { "vox.orgs": "1.0.0" } });
    const order = resolveActivationOrder([consumer, provider]).map((m) => m.id);
    expect(order.indexOf("orgs")).toBeLessThan(order.indexOf("consumer"));
    // and still resolves when the optional provider is absent
    expect(resolveActivationOrder([consumer]).map((m) => m.id)).toEqual(["consumer"]);
  });
});
