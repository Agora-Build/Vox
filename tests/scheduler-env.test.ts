import { describe, it, expect, afterEach } from "vitest";
import { positiveIntEnv } from "../server/scheduler";

// Operator overrides for the maintenance timings (#82: PENDING_NO_AGENT_TIMEOUT_MINUTES).
describe("positiveIntEnv", () => {
  const NAME = "VOX_TEST_POSITIVE_INT";
  afterEach(() => { delete process.env[NAME]; });

  it("unset or empty: the default", () => {
    expect(positiveIntEnv(NAME, 15)).toBe(15);
    process.env[NAME] = "";
    expect(positiveIntEnv(NAME, 15)).toBe(15);
  });

  it("a positive integer overrides it", () => {
    process.env[NAME] = "45";
    expect(positiveIntEnv(NAME, 15)).toBe(45);
  });

  it("anything else is ignored rather than trusted", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "10m"]) {
      process.env[NAME] = bad;
      expect(positiveIntEnv(NAME, 15)).toBe(15);
    }
  });
});
