import { describe, it, expect } from "vitest";
import { validatePlugin } from "../scripts/plugins-validate";

describe("validatePlugin", () => {
  it("passes for the sample plugin", () => {
    expect(validatePlugin("plugins/sample")).toEqual([]);
  });

  it("reports a route present in the manifest but missing from SPEC.md", () => {
    // the fake fixture has a route in its manifest and no SPEC.md
    const errors = validatePlugin("tests/fixtures/plugins/fake");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/SPEC\.md/);
  });
});
