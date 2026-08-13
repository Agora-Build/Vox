import { describe, it, expect } from "vitest";
import { parseManifest } from "../server/plugins/manifest";

const valid = {
  id: "sample",
  version: "1.0.0",
  voxPluginApi: "^1.0.0",
  providesServices: { "vox.sample": "1.0.0" },
  requiresServices: {},
  optionalServices: {},
  migrations: "migrations",
  routes: ["GET /api/plugins/sample/notes"],
};

describe("parseManifest", () => {
  it("accepts a valid manifest and applies defaults", () => {
    const m = parseManifest(valid);
    expect(m.id).toBe("sample");
    expect(m.requiresServices).toEqual({});
  });

  it("rejects unknown fields", () => {
    expect(() => parseManifest({ ...valid, wat: true })).toThrow();
  });

  it("rejects an invalid semver version", () => {
    expect(() => parseManifest({ ...valid, version: "not-semver" })).toThrow();
  });

  it("rejects an invalid plugin id", () => {
    expect(() => parseManifest({ ...valid, id: "Bad_ID" })).toThrow();
  });

  it("defaults optional service maps to {} when omitted", () => {
    const m = parseManifest({ ...valid, providesServices: undefined, requiresServices: undefined, optionalServices: undefined });
    expect(m.providesServices).toEqual({});
  });
});
