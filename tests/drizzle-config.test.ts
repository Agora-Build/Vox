import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// _plugin_schema_versions is created at runtime by server/plugins/migrate.ts
// and is deliberately NOT in shared/schema.ts. drizzle-kit push diffs the live
// public schema against schema.ts and DROPS unknown tables — losing the plugin
// migration history, so the next startup re-runs every plugin migration into
// its still-populated schema and crashes with "relation already exists".
// The tablesFilter exclusion in drizzle.config.ts is what prevents that;
// this test keeps it from being removed accidentally.
describe("drizzle.config.ts", () => {
  it("excludes _plugin_schema_versions from drizzle-kit's purview", () => {
    const config = readFileSync(
      path.resolve(__dirname, "../drizzle.config.ts"),
      "utf-8",
    );
    expect(config).toMatch(/tablesFilter:\s*\[[^\]]*"!_plugin_schema_versions"/);
  });
});
