import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("standalone agent network-monitor packaging", () => {
  it("bundles using only daemon-stage TypeScript COPY inputs and no Core validation dependencies", () => {
    const root = path.resolve(__dirname, "..");
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vox-agent-network-build-"));
    try {
      const dockerfile = fs.readFileSync(path.join(root, "vox_eval_agentd/Dockerfile"), "utf8").split("FROM base AS daemon")[1];
      for (const match of dockerfile.matchAll(/^COPY (\S+\.ts) (\S+)$/gm)) {
        const target = path.join(stage, match[2].replace(/^\//, ""), match[2].endsWith("/") ? path.basename(match[1]) : "");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, match[1]), target);
      }
      const result = buildSync({ entryPoints: [path.join(stage, "app/vox-agentd.ts")], platform: "node", format: "esm",
        bundle: true, write: false, metafile: true, external: ["js-yaml", "@aws-sdk/client-s3"], logLevel: "silent" });
      const inputs = Object.keys(result.metafile!.inputs).join("\n");
      expect(inputs).toContain("network-observer.ts");
      expect(inputs).toContain("network-event-protocol.ts");
      expect(inputs).not.toContain("zod");
      expect(inputs).not.toContain("server/");
      expect(result.outputFiles[0].text).toContain("evictedThroughSeq");
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });
});
