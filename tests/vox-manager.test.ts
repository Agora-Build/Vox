import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/vox-manager.sh");
const LEGACY_SCRIPT = path.resolve(__dirname, "../scripts/vox-upgrade.sh");
const DOWNLOAD_URL = "https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh";
const ORIGINAL = fs.readFileSync(SCRIPT, "utf8");
const UPDATED = `${ORIGINAL}\n# Updated test fixture; must not execute during self-update.\ntouch "$VM_EXECUTED"\n`;
const INVALID_ENV_ARGS = [
  ["--env"], ["--env="], ["--env", ""], ["--env", "--version", "latest"],
  ["--env=--help"], ["--env", ".env", "--env", "other.env"],
  ["--env=.env", "--env=other.env"], [".env", "--env", "other.env"],
  ["--env", ".env", "other.env"], ["--env=.env", "other.env"],
];

let dir: string;
let installed: string;
let legacy: string;
let fixture: string;
let log: string;
let executed: string;

function run(args: string[], options: { script?: string; env?: Record<string, string> } = {}) {
  fs.writeFileSync(log, "");
  const result = spawnSync("bash", [options.script ?? installed, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`,
      VM_LOG: log, VM_FIXTURE: fixture, VM_EXECUTED: executed,
      ...options.env,
    },
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(log, "utf8") };
}

function expectNoTemporaryFiles() {
  expect(fs.readdirSync(path.dirname(installed)).filter((name) => name.startsWith(".vox-manager-"))).toEqual([]);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-manager-test-"));
  const installDir = path.join(dir, "installed scripts");
  fs.mkdirSync(installDir);
  fs.mkdirSync(path.join(dir, "bin"));
  installed = path.join(installDir, "vox-manager.sh");
  legacy = path.join(installDir, "vox-upgrade.sh");
  fixture = path.join(dir, "download.sh");
  log = path.join(dir, "calls.log");
  executed = path.join(dir, "executed");
  fs.copyFileSync(SCRIPT, installed);
  fs.chmodSync(installed, 0o750);
  fs.copyFileSync(LEGACY_SCRIPT, legacy);
  fs.writeFileSync(fixture, UPDATED);
  fs.writeFileSync(path.join(dir, ".env"), 'touch "$VM_EXECUTED"\nexit 99\n');
  fs.writeFileSync(path.join(dir, "bin", "docker"), '#!/bin/bash\necho docker >> "$VM_LOG"\nexit 98\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "curl"), `#!/bin/bash
echo "curl $*" >> "$VM_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift 2; else shift; fi
done
if [ -n "\${VM_DOWNLOAD_FAIL:-}" ]; then
  printf partial > "$output"
  exit 22
fi
if [ -n "\${VM_DOWNLOAD_TERM:-}" ]; then
  kill -TERM "$PPID"
  exit 143
fi
cp "$VM_FIXTURE" "$output"
`, { mode: 0o755 });
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("management command dispatch", () => {
  it.each(["--help", "-h", "help"])("%s documents all commands without reading .env or calling external services", (command) => {
    const result = run([command]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("vox_agent");
    expect(result.out).toContain("--version");
    expect(result.out).toContain("--env");
    expect(result.out).toContain("current working directory");
    expect(result.out).toContain("self");
    expect(result.out).toContain("not supported yet");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it("vox rejects server operations before loading .env, downloading or checking Docker", () => {
    fs.writeFileSync(path.join(dir, "vox"), 'touch "$VM_EXECUTED"\n');
    const result = run(["vox"]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("not supported yet");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it.each([["unknown"], ["self", "extra"], ["vox_agent", "a", "b"]])("invalid arguments %j have no side effects", (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.out).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it.each([
    ["--version"], ["--version="], ["--version", ""], ["--version", "-latest"],
    ["--version", "repo/image:tag"], ["--version", "sha256:short"],
    ["--version", "a".repeat(129)], ["--version", "x y"], ["--version", "$(touch injected)"],
    ["--version", "old", "--version", "new"], ["--unknown"], ["self", "--version", "old"],
  ])("invalid version arguments %j are rejected before reading .env or calling Docker", (...args) => {
    const result = run(args[0] === "self" ? args : ["vox_agent", ...args]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it.each(INVALID_ENV_ARGS)("invalid env arguments %j are rejected before reading .env or calling Docker", (...args) => {
    const result = run(["vox_agent", ...args]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it("reports a missing explicit env file rather than falling back to .env", () => {
    const result = run(["vox_agent", "--env", "/missing/agent.env"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("env file not found: /missing/agent.env");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });

  it("an env file without tokens produces a clear error before Docker", () => {
    const envFile = path.join(dir, "empty.env");
    fs.writeFileSync(envFile, "");
    const result = run(["vox_agent", "--env", envFile]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("No AGENT_TOKEN or RUNNER_TOKEN");
    expect(result.calls).toBe("");
  });

  it("loads the current directory's .env, never a file found through PATH", () => {
    fs.writeFileSync(path.join(dir, ".env"), "");
    fs.writeFileSync(path.join(dir, "bin", ".env"), 'touch "$VM_EXECUTED"\nexit 99\n');
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("No AGENT_TOKEN or RUNNER_TOKEN");
    expect(result.calls).toBe("");
    expect(fs.existsSync(executed)).toBe(false);
  });
});

describe("atomic self-update", () => {
  it("replaces only the installed script, preserving permissions, without .env, Docker or executing the download", () => {
    const result = run(["self"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("Updated script:");
    expect(fs.readFileSync(installed, "utf8")).toBe(UPDATED);
    expect(fs.statSync(installed).mode & 0o777).toBe(0o750);
    expect(result.calls).toContain(DOWNLOAD_URL);
    expect(result.calls).toContain("--proto =https --proto-redir =https");
    expect(result.calls).not.toContain("docker");
    expect(fs.existsSync(executed)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("works with no env file at all", () => {
    fs.unlinkSync(path.join(dir, ".env"));
    expect(run(["self"]).status).toBe(0);
    expect(fs.readFileSync(installed, "utf8")).toBe(UPDATED);
  });

  it("preserves non-executable permissions when invoked explicitly with bash", () => {
    fs.chmodSync(installed, 0o640);
    expect(run(["self"]).status).toBe(0);
    expect(fs.statSync(installed).mode & 0o777).toBe(0o640);
  });

  it("updates the invoked file even if it has a different local name", () => {
    const renamed = path.join(path.dirname(installed), "my-vox.sh");
    fs.renameSync(installed, renamed);
    expect(run(["self"], { script: renamed }).status).toBe(0);
    expect(fs.readFileSync(renamed, "utf8")).toBe(UPDATED);
    expect(fs.existsSync(installed)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("an identical download leaves the installed inode untouched", () => {
    fs.writeFileSync(fixture, ORIGINAL);
    const inode = fs.statSync(installed).ino;
    const result = run(["self"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("Already running the latest script");
    expect(fs.statSync(installed).ino).toBe(inode);
    expectNoTemporaryFiles();
  });

  it("download failure preserves the installed file even after a partial response", () => {
    const result = run(["self"], { env: { VM_DOWNLOAD_FAIL: "1" } });
    expect(result.status).toBe(1);
    expect(result.out).toContain("installed script is unchanged");
    expect(fs.readFileSync(installed, "utf8")).toBe(ORIGINAL);
    expectNoTemporaryFiles();
  });

  it("interruption cleans the staging file and preserves the installed script", () => {
    const result = run(["self"], { env: { VM_DOWNLOAD_TERM: "1" } });
    expect(result.status).toBe(143);
    expect(fs.readFileSync(installed, "utf8")).toBe(ORIGINAL);
    expectNoTemporaryFiles();
  });

  it.skipIf(process.getuid?.() === 0)("refuses to replace a read-only script", () => {
    fs.chmodSync(installed, 0o440);
    const result = run(["self"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("writable script file and directory");
    expect(result.calls).toBe("");
    expect(fs.readFileSync(installed, "utf8")).toBe(ORIGINAL);
  });

  it.skipIf(process.getuid?.() === 0)("checks directory writability before attempting a download", () => {
    fs.chmodSync(path.dirname(installed), 0o550);
    try {
      const result = run(["self"]);
      expect(result.status).toBe(1);
      expect(result.out).toContain("writable script file and directory");
      expect(result.calls).toBe("");
    } finally {
      fs.chmodSync(path.dirname(installed), 0o750);
    }
  });

  it.each([
    "",
    "<html>Service unavailable</html>\n",
    "#!/usr/bin/env bash\necho wrong-script\n",
    "#!/usr/bin/env bash\n# vox-manager-script: 1\nif then\n",
  ])("rejects invalid download %j without changing the installed script", (content) => {
    fs.writeFileSync(fixture, content);
    const result = run(["self"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("not a valid Vox management script");
    expect(fs.readFileSync(installed, "utf8")).toBe(ORIGINAL);
    expectNoTemporaryFiles();
  });

  it("refuses to overwrite a symlink", () => {
    const link = path.join(dir, "manager-link.sh");
    fs.symlinkSync(installed, link);
    const result = run(["self"], { script: link });
    expect(result.status).toBe(1);
    expect(result.out).toContain("symlink");
    expect(result.calls).toBe("");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toBe(ORIGINAL);
  });
});

describe("legacy vox-upgrade.sh entry point", () => {
  it.each(INVALID_ENV_ARGS)("standalone env arguments %j cannot trigger a bootstrap download", (...args) => {
    fs.unlinkSync(installed);
    const result = run(args, { script: legacy });
    expect(result.status).toBe(2);
    expect(result.out).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(executed)).toBe(false);
  });

  it.each([["--help"], ["unknown"], ["self", "extra"], ["vox_agent", "a", "b"], ["vox_agent", "--version"], ["vox_agent", "--version", "x y"], ["vox_agent", "--version=latest", "--version", "old"]])("standalone arguments %j do not trigger a bootstrap download", (...args) => {
    fs.unlinkSync(installed);
    const result = run(args, { script: legacy });
    expect(result.status).toBe(args[0] === "--help" ? 0 : 2);
    expect(result.out).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(fs.existsSync(installed)).toBe(false);
  });

  it("self delegates to the existing manager without replacing the compatibility script", () => {
    const before = fs.readFileSync(legacy, "utf8");
    expect(run(["self"], { script: legacy }).status).toBe(0);
    expect(fs.readFileSync(installed, "utf8")).toBe(UPDATED);
    expect(fs.readFileSync(legacy, "utf8")).toBe(before);
    expect(fs.existsSync(executed)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("a standalone legacy download bootstraps the canonical script once without executing it for self", () => {
    fs.unlinkSync(installed);
    const result = run(["self"], { script: legacy });
    expect(result.status).toBe(0);
    expect(result.out).toContain("Installed the latest management script");
    expect(fs.readFileSync(installed, "utf8")).toBe(UPDATED);
    expect(fs.statSync(installed).mode & 0o777).toBe(0o755);
    expect(result.calls.match(/curl /g)).toHaveLength(1);
    expect(result.calls).not.toContain("docker");
    expect(fs.existsSync(executed)).toBe(false);
    expectNoTemporaryFiles();
  });

  it.each(["download failure", "invalid response"])("a standalone legacy %s does not install or execute a bad script", (failure) => {
    fs.unlinkSync(installed);
    fs.writeFileSync(fixture, "<html>error</html>\n");
    const result = run(["self"], { script: legacy, env: failure === "download failure" ? { VM_DOWNLOAD_FAIL: "1" } : {} });
    expect(result.status).toBe(1);
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(executed)).toBe(false);
    expect(result.calls).not.toContain("docker");
    expectNoTemporaryFiles();
  });

  it.each([
    ["vox_agent", "--version", "7c3b1a2", "--env", "/path with spaces/agent.env"],
    ["--env", "/path with spaces/agent.env", "--version=7c3b1a2"],
    ["vox_agent", "--env=/path with spaces/agent.env"],
    ["vox_agent", "/path with spaces/agent.env"],
  ])("a standalone legacy launcher forwards arguments %j unchanged", (...args) => {
    fs.unlinkSync(installed);
    fs.writeFileSync(fixture, '#!/usr/bin/env bash\n# vox-manager-script: 1\nprintf "argument: <%s>\\n" "$@"\n');
    const result = run(args, { script: legacy });
    expect(result.status).toBe(0);
    expect(result.out).toContain(args.map((arg) => `argument: <${arg}>`).join("\n"));
    expect(result.calls.match(/curl /g)).toHaveLength(1);
    expectNoTemporaryFiles();
  });

  it("vox never bootstraps or touches Docker", () => {
    fs.unlinkSync(installed);
    const result = run(["vox"], { script: legacy });
    expect(result.status).toBe(2);
    expect(result.out).toContain("not supported yet");
    expect(result.calls).toBe("");
    expect(fs.existsSync(installed)).toBe(false);
  });
});
