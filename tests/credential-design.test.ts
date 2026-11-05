import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIAL_LIMIT_24_HOURS, TRIAL_LIMIT_30_DAYS } from "../shared/credential-trials";

describe("living credential design", () => {
  const design = readFileSync("designs/agent-credentials-design.md", "utf8");
  it("keeps documented defaults aligned with implementation and migration", () => {
    expect(design).toContain(`| Per-user 24-hour limit | Caller + eval flow, rolling window | ${TRIAL_LIMIT_24_HOURS} |`);
    expect(design).toContain(`| Per-user 30-day limit | Caller + eval flow, rolling window | ${TRIAL_LIMIT_30_DAYS} |`);
    const migration = readFileSync("migrations/0066_credential_trials.sql", "utf8");
    expect(migration).toContain(`trial_limit_24_hours integer NOT NULL DEFAULT ${TRIAL_LIMIT_24_HOURS}`);
    expect(migration).toContain(`trial_limit_30_days integer NOT NULL DEFAULT ${TRIAL_LIMIT_30_DAYS}`);
  });
  it("links deployment guidance to the maintained policy and records safe defaults", () => {
    const deployment = readFileSync("docs/DEPLOYMENT.md", "utf8");
    expect(deployment).toContain("## Credential-policy rollout (schema 67)");
    expect(deployment).toContain("Borrowing stays **off by default**");
    expect(deployment).toContain("../designs/agent-credentials-design.md");
    expect(design).toContain("docs/DEPLOYMENT.md#credential-policy-rollout-schema-67");
  });
  it("documents the broker environment names used by both binaries", () => {
    for (const variable of ["BROKER_REG_TOKEN", "VOX_CORE_URL", "BROKER_ADVERTISE_URL"]) {
      expect(design).toContain(`\`${variable}\``);
      for (const path of ["vox_eval_agentd/auth-session-broker.ts", "vox_rest_broker/rest-broker.ts"]) {
        expect(readFileSync(path, "utf8")).toContain(`process.env.${variable}`);
      }
    }
    expect(design).not.toContain("BROKER_REGISTRATION_TOKEN");
  });
  it.each([
    "designs/2026-08-20-secret-class-protected-runtime-design.md",
    "designs/2026-08-21-broker-registry-design.md",
    "designs/2026-08-24-tier-targeting-design.md",
    "designs/2026-09-29-secret-substitution.md",
    "designs/2026-11-05-agent-credential-trust/agent-credential-trust-design.md",
    "docs/secrets-flow.md",
  ])("keeps the historical link without a competing policy: %s", (path) => {
    const pointer = readFileSync(path, "utf8");
    expect(pointer).toContain("agent-credentials-design.md");
    expect(pointer).toContain("Superseded");
    expect(pointer).not.toContain("3 runs");
  });
});
