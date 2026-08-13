import { describe, it, expect } from "vitest";
import { VOX_PLUGIN_API_VERSION } from "@vox/plugin-sdk";

describe("@vox/plugin-sdk", () => {
  it("exposes the API version through the path alias", () => {
    expect(VOX_PLUGIN_API_VERSION).toBe("1.0.0");
  });
});
