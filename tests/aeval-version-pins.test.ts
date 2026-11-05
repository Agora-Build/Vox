import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "vox_eval_agentd/Dockerfile"), "utf8");
const localScript = fs.readFileSync(path.join(root, "scripts/dev-local-run.sh"), "utf8");
const notesPath = path.join(root, "vox_eval_agentd/aeval-data/release/LATEST_RELEASE_NOTES.md");
const binaryVersion = dockerfile.match(/^ARG AEVAL_VERSION=v(\d+\.\d+\.\d+)$/m)?.[1];

describe("aeval release pins", () => {
  it("keeps the local minimum aligned with the pinned Docker binary", () => {
    expect(binaryVersion).toBeDefined();
    expect(localScript.match(/^AEVAL_MIN_VERSION="([^"]+)"$/m)?.[1]).toBe(binaryVersion);
  });

  it.skipIf(!fs.existsSync(notesPath))("keeps runtime data aligned with the binary release", () => {
    const notes = fs.readFileSync(notesPath, "utf8");
    expect(notes.match(/^#\s+aeval\s+v(\d+\.\d+\.\d+)\s*$/m)?.[1]).toBe(binaryVersion);
  });

  it("keeps the local and Docker Playwright versions aligned", () => {
    const playwrightVersion = dockerfile.match(/playwright==(\d+\.\d+\.\d+)/)?.[1];
    expect(playwrightVersion).toBeDefined();
    expect(localScript.match(/^AEVAL_PLAYWRIGHT_VERSION="([^"]+)"$/m)?.[1]).toBe(playwrightVersion);
  });
});
