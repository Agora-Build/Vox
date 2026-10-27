import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

// Regression guard for the broken-YAML incident where a plain scalar
// `description` containing ": " (e.g. "key:value tags: ...") was read by
// YAML as a nested mapping ("bad indentation of a mapping entry"), which
// made GET /api/v1/openapi.json 500 in server/routes.ts. This loads
// docs/openapi.yaml with the same library (js-yaml) and in the same way
// (yaml.load on the raw file contents) that route uses.
describe("docs/openapi.yaml", () => {
  const specPath = path.join(process.cwd(), "docs", "openapi.yaml");
  const specContent = fs.readFileSync(specPath, "utf-8");

  it("parses as valid YAML", () => {
    expect(() => yaml.load(specContent)).not.toThrow();
  });

  it("has the expected top-level OpenAPI structure", () => {
    const spec = yaml.load(specContent) as any;
    expect(spec).toBeTruthy();
    expect(typeof spec.openapi).toBe("string");
    expect(typeof spec.paths).toBe("object");
    expect(spec.paths).not.toBeNull();
  });
});
