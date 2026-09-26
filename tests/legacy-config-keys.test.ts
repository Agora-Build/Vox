import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { LEGACY_CONFIG_KEY_PREFIX } from "../shared/secrets";
import { stripLegacyConfigKeys, carryOverLegacyKeys } from "../server/storage";

/**
 * `_legacy*` config keys are migration-parked dead payloads. Three properties
 * hold them together, and two of them are easy to break later:
 *
 *  1. The secret scans SKIP these keys (shared/secrets.ts), so a reference
 *     hidden in one can't trip the run gates on a migrated row.
 *  2. Therefore no caller may WRITE one — otherwise `${config._legacyX}`
 *     indirection smuggles a secret reference past those same scans.
 *  3. But a stored one must SURVIVE an unrelated edit, or the migration's
 *     whole reason for parking it is defeated.
 *
 * (2) is the fragile one: it depends on every config-accepting route calling
 * stripLegacyConfigKeys, and a route added later would silently opt out. This
 * scans the source rather than trusting a hand-kept list — the same approach
 * as tests/sensitive-paths.test.ts, which exists because a hand-kept list had
 * already gone stale.
 */
const ROUTE_FILES = ["server/routes.ts", "server/routes-api-v1.ts"];

describe("_legacy* config keys", () => {
  it("every route reading req.body.config strips caller-supplied keys", () => {
    const offenders: string[] = [];
    for (const file of ROUTE_FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/req\.body(\?)?\.config/.test(line)) return;
        // Window, not single line: these reads sit inside multi-line ternaries
        // (`x === null ? x : carryOverLegacyKeys(strip(x), row.config)`), so
        // the guard is a line or two away. A NEW route that reads the config
        // and never strips it has no guard anywhere near.
        const window = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
        if (!/stripLegacyConfigKeys|carryOverLegacyKeys/.test(window)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `These read req.body.config without stripLegacyConfigKeys — a caller could park a\n` +
        `key the secret scans deliberately skip:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("strips caller-supplied keys but preserves everything else", () => {
    expect(stripLegacyConfigKeys({ framework: "aeval", _legacyX: "smuggled", stepsPrefix: "- a" }))
      .toEqual({ framework: "aeval", stepsPrefix: "- a" });
    // Non-objects pass through untouched (a scalar config reaches storage as-is).
    expect(stripLegacyConfigKeys(null)).toBeNull();
    expect(stripLegacyConfigKeys("scalar")).toBe("scalar");
  });

  it("carries STORED keys across an edit without letting a caller inject one", () => {
    const stored = { framework: "aeval", _legacyPhoneDial: { number: "+1 555 010 1234" } };
    const incoming = stripLegacyConfigKeys({ framework: "aeval", stepsPrefix: "- b", _legacyInjected: "nope" });
    const merged = carryOverLegacyKeys(incoming, stored) as Record<string, unknown>;
    expect(merged._legacyPhoneDial).toEqual({ number: "+1 555 010 1234" }); // survived
    expect(merged._legacyInjected).toBeUndefined(); // never accepted
    expect(merged.stepsPrefix).toBe("- b"); // the actual edit applied
  });

  it("the prefix is the shared constant, so the scans can't drift apart", () => {
    expect(LEGACY_CONFIG_KEY_PREFIX).toBe("_legacy");
    for (const file of ["server/storage.ts", "vox_eval_agentd/vox-agentd.ts", "client/src/pages/console-evalflows.tsx"]) {
      const src = readFileSync(file, "utf8");
      // No hand-rolled copies of the literal prefix in the guards.
      expect(src.includes('startsWith("_legacy")') || src.includes("startsWith('_legacy')")).toBe(false);
    }
  });
});
