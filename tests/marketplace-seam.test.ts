import { describe, it, expect, beforeEach } from "vitest";
import { getMarketplace, setMarketplace, type EvalMarketplace } from "../server/marketplace";
import { makeServicesView } from "../server/plugins/loader";
import { ServiceRegistry } from "../server/plugins/registry";

const fakeMarketplace: EvalMarketplace = {
  async listDispatchable() { return []; },
  async authorizeDispatch() { return { ok: true }; },
  async settle() {},
  async setListing() {},
  async updateListingRegion() {},
};

describe("marketplace singleton", () => {
  beforeEach(() => setMarketplace(null));

  it("defaults to null (no plugin loaded)", () => {
    expect(getMarketplace()).toBeNull();
  });
  it("set then get returns the instance", () => {
    setMarketplace(fakeMarketplace);
    expect(getMarketplace()).toBe(fakeMarketplace);
  });
  it("can be cleared back to null", () => {
    setMarketplace(fakeMarketplace);
    setMarketplace(null);
    expect(getMarketplace()).toBeNull();
  });
});

describe("makeServicesView", () => {
  it("optional() returns null for an unregistered service", () => {
    const view = makeServicesView(new ServiceRegistry());
    expect(view.optional("vox.eval-marketplace", "^1.0.0")).toBeNull();
  });
  it("optional() returns a provided service", () => {
    const registry = new ServiceRegistry();
    registry.provide("vox.eval-marketplace", "1.0.0", fakeMarketplace);
    const view = makeServicesView(registry);
    expect(view.optional("vox.eval-marketplace", "^1.0.0")).toBe(fakeMarketplace);
  });
});
