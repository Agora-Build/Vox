import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const root = path.resolve(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "vox_eval_agentd/Dockerfile"), "utf8");
const localScript = fs.readFileSync(path.join(root, "scripts/dev-local-run.sh"), "utf8");
const dataPath = path.join(root, "vox_eval_agentd/aeval-data");
const hasRuntimeData = fs.existsSync(dataPath) && fs.readdirSync(dataPath).length > 0;
const notesPath = path.join(dataPath, "release/LATEST_RELEASE_NOTES.md");
const binaryVersion = dockerfile.match(/^ARG AEVAL_VERSION=v(\d+\.\d+\.\d+)$/m)?.[1];

describe("aeval release pins", () => {
  it("keeps the local minimum aligned with the pinned Docker binary", () => {
    expect(binaryVersion).toBeDefined();
    expect(localScript.match(/^AEVAL_MIN_VERSION="([^"]+)"$/m)?.[1]).toBe(binaryVersion);
  });

  it.skipIf(!hasRuntimeData)("keeps runtime data aligned with the binary release", () => {
    const notes = fs.readFileSync(notesPath, "utf8");
    expect(notes.match(/^#\s+aeval\s+v(\d+\.\d+\.\d+)\s*$/m)?.[1]).toBe(binaryVersion);
  });

  it.each([
    { arch: "X86_64", asset: "aeval-linux-x86_64" },
    { arch: "ARM64", asset: "aeval-linux-arm64" },
  ])("verifies the pinned checksum for $asset before making it executable", ({ arch, asset }) => {
    const checksum = dockerfile.match(new RegExp(`^ARG AEVAL_SHA256_${arch}=([a-f0-9]{64})$`, "m"))?.[1];
    expect(checksum).toBeDefined();
    expect(dockerfile).toContain(`SHA256="\${AEVAL_SHA256_${arch}}"`);
    expect(dockerfile).toMatch(/sha256sum --check --status\s*&&\s*\\\n\s*chmod \+x/);
    if (hasRuntimeData) {
      const sums = fs.readFileSync(path.join(dataPath, "release/aeval_SHA256SUMS.txt"), "utf8");
      expect(sums.match(new RegExp(`^([a-f0-9]{64})\\s+${asset}$`, "m"))?.[1]).toBe(checksum);
    }
  });

  it("keeps the local and Docker Playwright versions aligned", () => {
    const playwrightVersion = dockerfile.match(/playwright==(\d+\.\d+\.\d+)/)?.[1];
    expect(playwrightVersion).toBeDefined();
    expect(localScript.match(/^AEVAL_PLAYWRIGHT_VERSION="([^"]+)"$/m)?.[1]).toBe(playwrightVersion);
  });

  it.skipIf(!hasRuntimeData)("preserves explicit storage-first intent in the account setup, not storage-only mode", () => {
    const platform = yaml.load(fs.readFileSync(path.join(dataPath, "config/platforms/elevenlabs.yaml"), "utf8")) as {
      actions: Record<string, Record<string, unknown>[]>;
    };
    expect(platform.actions["setup:account"][0]).toMatchObject({
      type: "browser.ensure_authenticated", authentication: "${config.authentication}",
      restore_storage_file: "${params._restore_storage_file}", storage_file: "${params.storage_file}",
      email: "${params.email}", password: "${params.password}",
    });
    expect(platform.actions["setup:storage"].some((step) => step.type === "browser.ensure_authenticated")).toBe(false);
  });

  it.skipIf(!hasRuntimeData)("pins the qualified ElevenLabs email stage instead of matching Resend verification", () => {
    const platform = yaml.load(fs.readFileSync(path.join(dataPath, "config/platforms/elevenlabs.yaml"), "utf8")) as {
      config: { authentication: { stages: Record<string, unknown>[] } };
    };
    expect(platform.config.authentication.stages.find((stage) => stage.id === "email")).toMatchObject({
      selector: "body:has(button[data-testid='sign-in-submit-button']:has-text('Sign in')) input[data-testid='sign-in-email-input']",
      fields: { email: "input[data-testid='sign-in-email-input']" },
      submit: "button[data-testid='sign-in-submit-button']",
    });
  });
});
