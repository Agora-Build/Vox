import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { dialfConnectFailure, probeDialf } from "../vox_eval_agentd/dialf-client";

// scripts/vox-manager.sh and DialF (Phone vs Agent). A phone agent stopped
// taking phone jobs after an upgrade: the script mounts dialfd's socket only
// if it finds it, said nothing when it didn't, skipped "same image" containers
// that lacked the mount, and couldn't tell a stale socket or a permission
// problem from anything else. These run the REAL script against a stub
// `docker` (which records every call and plays back container state) and a
// real Unix socket standing in for dialfd — and pin that hosts WITHOUT DialF
// see the same container actions as before.

const SCRIPT = path.resolve(__dirname, "../scripts/vox-manager.sh");
const IMAGE_NEW = `sha256:${"a".repeat(64)}`;
const IMAGE_OLD = `sha256:${"b".repeat(64)}`;
const MANIFEST_NEW = `sha256:${"c".repeat(64)}`;
const MANIFEST_OLD = `sha256:${"d".repeat(64)}`;
const AGENT_REF = `ghcr.io/agora-build/vox-eval-agentd@${MANIFEST_NEW}`;
const RUNNER_REF = `ghcr.io/agora-build/vox-clash-runner@${MANIFEST_NEW}`;
let dir = "";
let sock = "";
let sockServer: net.Server;

const STUB_DOCKER = `#!/bin/bash
echo "docker $*" >> "$VU_LOG"
case "$1" in
  info) [ -n "\${DOCKER_DENIED:-}" ] && { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }; echo ok ;;
  ps) echo "\${RUNNING_ID:-}" ;;
  pull)
    [ -n "\${PULL_FAIL_IMAGE:-}" ] && [[ "$2" == *"$PULL_FAIL_IMAGE"* ]] && exit 1
    [ -n "\${PULL_FAIL_AT:-}" ] && [ "$(grep -c '^docker pull' "$VU_LOG")" = "$PULL_FAIL_AT" ] && exit 1
    exit 0 ;;
  image)
    [ -n "\${TARGET_INSPECT_FAIL:-}" ] && exit 1
    if [[ "$*" == *RepoDigests* ]]; then
      [ -n "\${DIGEST_INSPECT_FAIL:-}" ] && exit 1
      [ -n "\${DIGEST_FAIL_AT:-}" ] && [ "$(grep -c 'docker image inspect.*RepoDigests' "$VU_LOG")" = "$DIGEST_FAIL_AT" ] && exit 1
      if [ "\${REPO_DIGESTS+x}" ]; then printf '%s\\n' "$REPO_DIGESTS"
      else
        manifest=${MANIFEST_NEW}
        [ "$3" = ${IMAGE_OLD} ] && manifest=${MANIFEST_OLD}
        printf 'ghcr.io/agora-build/vox-eval-agentd@%s\\nghcr.io/agora-build/vox-clash-runner@%s\\n' "$manifest" "$manifest"
      fi
      exit 0
    fi
    if [[ "$3" == *@sha256:* ]]; then
      [ -n "\${PINNED_INSPECT_FAIL:-}" ] && exit 1
      if [ "\${PINNED_IMAGE_ID+x}" ]; then echo "$PINNED_IMAGE_ID"; exit 0; fi
    fi
    if [[ "$*" == *vox-clash-runner* ]] && [ -n "\${RUNNER_TARGET_IMAGE:-}" ]; then echo "$RUNNER_TARGET_IMAGE"
    else echo "\${LATEST_IMAGE-${IMAGE_NEW}}"; fi ;;
  inspect)
    case "$*" in
      *"{{.Image}}"*) [ -n "\${IMAGE_INSPECT_FAIL:-}" ] && exit 1; echo "\${RUNNING_IMAGE:-${IMAGE_OLD}}" ;;
      *"Config.Env"*) [ -n "\${INSPECT_FAIL:-}" ] && exit 1; [ -n "\${PREV_SOCK:-}" ] && echo "VOX_DIALF_SOCKET=$PREV_SOCK"; [ -n "\${PREV_HEALTH_PORT:-}" ] && echo "HEALTH_PORT=$PREV_HEALTH_PORT"; echo "AGENT_TOKEN=x" ;;
      *"RestartPolicy"*) echo "unless-stopped" ;;
      *"NetworkSettings"*) echo "\${CONTAINER_IP:-}" ;;
      *) echo "" ;;
    esac ;;
  exec) case "$*" in *stat*) [ -n "\${CONT_INO:-}" ] && echo "$CONT_INO" || exit 1 ;; *) exit 0 ;; esac ;;
  logs) [ -n "\${PROBE_LINE:-}" ] && echo "$PROBE_LINE"; echo "[Daemon] Heartbeat sent" ;;
  port) [ -z "\${NO_HEALTH_MAPPING:-}" ] && echo "\${HEALTH_MAPPING:-127.0.0.1:49152}" ;;
  run)
    binding=""
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = -p ]; then next=$((i+1)); binding="\${!next}"; break; fi
    done
    if [[ "$binding" == 127.0.0.1::* ]]; then
      allocated=$((49152 + $(grep -c '^docker run' "$VU_LOG")))
      echo "published 127.0.0.1:$allocated -> \${binding##*:}" >> "$VU_LOG"
    else
      host_port="\${binding%%:*}"
      if [ "$host_port" = "\${OCCUPIED_HOST_PORT:-}" ] || grep -q "^published $host_port$" "$VU_LOG"; then
        echo "port is already allocated" >&2; exit 125
      fi
      echo "published $host_port" >> "$VU_LOG"
    fi
    echo "newcontainer000111" ;;
  *) ;;
esac
`;
const STUB_CURL = `#!/bin/bash
echo "curl $*" >> "$VU_LOG"
attempt=$(grep -c '^curl ' "$VU_LOG")
steps="\${HEALTH_STEPS:-idle}"
step=$(printf '%s\\n' "$steps" | sed -n "\${attempt}p")
[ -n "$step" ] || step=$(printf '%s\\n' "$steps" | tail -1)
case "$step" in
  timeout) exit 28 ;;
  http-error) [[ " $* " == *" --fail "* ]] && exit 22; printf '{"status":"idle"}\\n503'; exit 0 ;;
  redirect) printf '{"status":"idle"}\\n302'; exit 0 ;;
  body) printf '%s' "$HEALTH_BODY" ;;
  *) printf '{"status":"%s","uptime":123,"currentJobId":null}\\n' "$step" ;;
esac
printf '\\n200'
`;
const STUB_PS = `#!/bin/bash
if [ "$*" = "-o uid= -C dialfd" ]; then [ -n "\${PS_DIALF_UID:-}" ] && echo "  $PS_DIALF_UID"; exit 0; fi
exec /usr/bin/ps "$@"
`;
// Shadows the real `ip` (network tags' host_link_type, Linux branch) so
// autodetection is deterministic here regardless of the test host's actual
// network: with no route to report, host_link_type always returns nothing
// unless a test overrides VOX_LINK_TYPE directly (the documented, least-
// invasive test hook — same precedence host_link_type gives a real .env).
// A test may set IP_ROUTE_OUT to make `ip route get` report a route (every
// ip call is logged as "ip <args>"); unset, it reports none.
const STUB_IP = `#!/bin/bash
echo "ip $*" >> "$VU_LOG"
if [ "$1" = "route" ] && [ -n "\${IP_ROUTE_OUT:-}" ]; then echo "$IP_ROUTE_OUT"; exit 0; fi
if [ "$1" = "-o" ] && [ -n "\${IP_ADDR_OUT:-}" ]; then echo "$IP_ADDR_OUT"; exit 0; fi
exit 1
`;

/** Run the real script; returns its output and the docker calls it made. */
function upgrade(env: Record<string, string>, opts: { runner?: boolean; both?: boolean; answers?: string; command?: boolean; defaultEnv?: boolean; version?: string; args?: string[] } = {}) {
  const log = path.join(dir, `calls-${Math.random()}.log`);
  fs.writeFileSync(log, "");
  const envFile = path.join(dir, opts.both ? "both.env" : opts.runner ? "runner.env" : "agent.env");
  const args = opts.defaultEnv ? (opts.command ? ["vox_agent"] : []) : opts.command ? ["vox_agent", envFile] : [envFile];
  if (opts.version !== undefined) args.push("--version", opts.version);
  if (opts.args) args.push(...opts.args);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: dir,
    input: opts.answers ?? "",
    encoding: "utf8",
    env: {
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, VU_LOG: log,
      XDG_RUNTIME_DIR: path.join(dir, "no-runtime"), DIALF_CHECK_TRIES: "1", ...env,
    },
    timeout: 30_000,
  });
  expect(r.error).toBeUndefined();
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const actions = calls.filter((c) => /^docker (stop|rm|run|restart)\b/.test(c)).map((c) => c.split(" ")[1]);
  return { out: `${r.stdout}${r.stderr}`, status: r.status, calls, actions };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-manager-dialf-test-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ps"), STUB_PS, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ip"), STUB_IP, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "curl"), STUB_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "sleep"), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "agent.env"), "AGENT_TOKEN=evtest\nVOX_SERVER=http://localhost:5000\n");
  fs.writeFileSync(path.join(dir, "runner.env"), "RUNNER_TOKEN=crtest\nVOX_SERVER=http://localhost:5000\n");
  fs.writeFileSync(path.join(dir, "both.env"), "AGENT_TOKEN=evtest\nRUNNER_TOKEN=crtest\nVOX_SERVER=http://localhost:5000\n");
  sock = path.join(dir, "dialfd.sock");
  sockServer = net.createServer().listen(sock);
  await new Promise((r) => sockServer.once("listening", r));
});
afterAll(() => { sockServer?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("hosts WITHOUT DialF: positional and explicit commands keep the same container actions", () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["web agent, same image", { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_NEW }, false],
    ["web agent, new image", { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW }, false],
    ["clash runner, new image", { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW }, true],
  ];
  for (const [name, env, runner] of cases) {
    it(name, () => {
      const before = upgrade(env, { runner });
      const after = upgrade(env, { runner, command: true });
      expect(before.status).toBe(0);
      expect(after.status).toBe(0);
      expect(after.actions).toEqual(env.RUNNING_IMAGE === env.LATEST_IMAGE ? [] : ["stop", "rm", "rm", "run"]);
      expect(after.actions).toEqual(before.actions);                       // stop/rm/run unchanged
      const runOf = (r: typeof after) => r.calls.find((c) => c.startsWith("docker run"));
      expect(runOf(after)).toEqual(runOf(before));                           // same container config
      expect(after.out).not.toMatch(/WARNING|Restart|recreat|Continue|\(y\/n\)/); // nothing alarming, no prompt
    });
  }
});

describe("official image names and deployment provenance", () => {
  it.each([
    [false, "latest"], [true, "latest"],
    [false, "7c3b1a2"], [true, "7c3b1a2"],
    [false, MANIFEST_OLD], [true, MANIFEST_OLD],
  ] as const)("preserves the official repository, selected version, and immutable launch (runner=%s, version=%s)", (runner, version) => {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    const repo = `ghcr.io/agora-build/${component}`;
    const isDigest = version.startsWith("sha256:");
    const selected = `${repo}${isDigest ? "@" : ":"}${version}`;
    const pinned = `${repo}@${isDigest ? version : MANIFEST_NEW}`;
    const r = upgrade({ RUNNING_ID: "abc" }, { runner, version });
    expect(r.status).toBe(0);
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(run?.endsWith(` ${pinned}`)).toBe(true);
    expect(run).toContain(`--name ${component} `);
    expect(run).toContain("--pull=never ");
    expect(run).toContain(`--label org.agora.vox.image=${selected} `);
    expect(run).toContain(`--label org.agora.vox.version=${version} `);
    expect(run?.endsWith(` ${IMAGE_NEW}`)).toBe(false);
    expect(r.calls.find((call) => call.startsWith("docker container ls"))).toContain('{{.Label "org.agora.vox.version"}}');
  });

  it("resolves the manifest from the verified ID, not a second read of the mutable tag", () => {
    const r = upgrade({ RUNNING_ID: "abc" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker image inspect ${IMAGE_NEW} --format={{range .RepoDigests}}{{println .}}{{end}}`);
    expect(r.calls.filter((call) => call === "docker image inspect ghcr.io/agora-build/vox-eval-agentd:latest --format={{.Id}}")).toHaveLength(1);
    expect(r.calls).toContain(`docker image inspect ${AGENT_REF} --format={{.Id}}`);
  });

  it("ignores digests from other registries or repositories on the same local image", () => {
    const r = upgrade({
      RUNNING_ID: "abc",
      REPO_DIGESTS: `example.com/vox-eval-agentd@${MANIFEST_NEW}\n${RUNNER_REF}\n${AGENT_REF}`,
    });
    expect(r.status).toBe(0);
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ${AGENT_REF}`)).toBe(true);
  });

  it.each([
    "", "sha256:short", `example.com/vox-eval-agentd@${MANIFEST_NEW}`,
    RUNNER_REF, "ghcr.io/agora-build/vox-eval-agentd@sha256:short",
  ])("missing or invalid official digest %j leaves running containers untouched", (repoDigests) => {
    const r = upgrade({ RUNNING_ID: "abc", REPO_DIGESTS: repoDigests });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("could not verify an immutable ghcr.io/agora-build/vox-eval-agentd reference");
    expect(r.out).toContain("No containers were changed");
  });

  it.each([
    { DIGEST_INSPECT_FAIL: "1" },
    { PINNED_INSPECT_FAIL: "1" },
    { PINNED_IMAGE_ID: IMAGE_OLD },
  ])("digest inspection/verification failure %j never falls back to a bare ID or tag", (failure) => {
    const r = upgrade({ RUNNING_ID: "abc", ...failure });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
  });

  it("a second-component digest failure cannot partially replace the first component", () => {
    const r = upgrade({ RUNNING_ID: "abc", DIGEST_FAIL_AT: "2" }, { both: true });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.calls.filter((call) => call.startsWith("docker image inspect") && call.includes("RepoDigests"))).toHaveLength(2);
    expect(r.out).toContain("No containers were changed");
  });
});

describe("health checks fail closed before interrupting work", () => {
  it.each([false, true])("requires an explicit idle response (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { runner });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    expect(r.out).toContain("Status: idle after 0s");
  });

  it.each(["occupied", "uploading", "timeout", "http-error"])("retries %s and stops only after explicit idle", (status) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: `${status}\nidle` });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    expect(r.out).toContain("Status: idle after 10s");
    expect(r.calls.filter((call) => call.startsWith("curl "))).toHaveLength(2);
  });

  it.each(["timeout", "http-error", "redirect", "occupied", "uploading", "unrecognized"])("%s never silently stops an agent, including on EOF", (status) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: status });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("stopping may interrupt active work");
    expect(r.out).toContain("Skipping vox-eval-agentd");
    expect(r.calls.filter((call) => call.startsWith("curl "))).toHaveLength(31);
  });

  it.each([
    "", "not JSON", '{"status":"idle"', '{"status":"idle",}',
    '{"status":"idle"} trailing', '{"status":"idle","status":"occupied"}',
    '{"status":"idle","nested":{"status":"occupied"}}',
    '{"nested":{"status":"idle"}}', '{"status":"idle","uptime":01}',
    '{"status":"idle","uptime":NaN}', '{"status":"idle","buildTag":"bad\\x"}',
    '{"status":"idle","\\u0073tatus":"occupied"}',
  ])("malformed or unsupported health payload %j is not idle", (body) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "body", HEALTH_BODY: body });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("container is unknown after 300s");
  });

  it.each([
    '{ "status" : "idle", "uptime": 42, "buildTag":"dev", "currentJobId":null }',
    String.raw`{
 "currentMatchId":null, "buildTag":"tag\"quoted", "status":"idle", "uptime":1.5e3
}`,
  ])("accepts valid flat endpoint JSON with whitespace and metadata", (body) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "body", HEALTH_BODY: body });
    expect(r.status).toBe(0);
    expect(r.actions).toContain("stop");
    expect(r.out).toContain("Status: idle after 0s");
  });

  it("a busy response followed by health failure never becomes idle", () => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "occupied\ntimeout" }, { answers: "n\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("container is unknown after 300s");
    expect(r.out).not.toContain("safe to stop");
  });

  it("missing health endpoint remains unknown and leaves the container running", () => {
    const r = upgrade({ RUNNING_ID: "abc", NO_HEALTH_MAPPING: "1" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.calls.some((call) => call.startsWith("curl "))).toBe(false);
    expect(r.out).toContain("container is unknown after 300s");
  });

  it("falls back to the container IP for older unpublished health endpoints", () => {
    const r = upgrade({ RUNNING_ID: "abc", NO_HEALTH_MAPPING: "1", CONTAINER_IP: "172.18.0.2" });
    expect(r.status).toBe(0);
    expect(r.actions).toContain("stop");
    expect(r.calls.find((call) => call.startsWith("curl "))).toContain("http://172.18.0.2:8099/health");
  });

  it("only explicit confirmation permits force-stopping an unknown container", () => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "timeout" }, { answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    expect(r.out).toContain("container is unknown after 300s");
  });
});

describe("Docker-assigned loopback health ports", () => {
  it("agent and runner coexist even when the old fixed host port is occupied", () => {
    const r = upgrade({ RUNNING_ID: "abc", OCCUPIED_HOST_PORT: "8099" }, { both: true });
    expect(r.status).toBe(0);
    const runs = r.calls.filter((call) => call.startsWith("docker run"));
    expect(runs).toHaveLength(2);
    expect(runs.every((call) => call.includes("-p 127.0.0.1::8099 "))).toBe(true);
    expect(runs.every((call) => call.includes("-e HEALTH_PORT=8099 "))).toBe(true);
    const ports = r.calls.filter((call) => call.startsWith("published "));
    expect(ports).toEqual(["published 127.0.0.1:49153 -> 8099", "published 127.0.0.1:49154 -> 8099"]);
  });

  it("discovers an existing dynamic port while preserving the container's internal port", () => {
    const r = upgrade({ RUNNING_ID: "abc", PREV_HEALTH_PORT: "8100", HEALTH_PORT: "8101", HEALTH_MAPPING: "127.0.0.1:54321" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker port abc 8100/tcp");
    expect(r.calls.find((call) => call.startsWith("curl "))).toContain("http://127.0.0.1:54321/health");
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(run).toContain("-p 127.0.0.1::8101 ");
    expect(run).toContain("-e HEALTH_PORT=8101 ");
  });

  it("loads a custom internal port from the selected env file for both components", () => {
    const envFile = path.join(dir, "custom-health.env");
    fs.writeFileSync(envFile, "AGENT_TOKEN=evtest\nRUNNER_TOKEN=crtest\nHEALTH_PORT=8123\n");
    const r = upgrade({ RUNNING_ID: "abc" }, { defaultEnv: true, args: ["--env", envFile] });
    expect(r.status).toBe(0);
    const runs = r.calls.filter((call) => call.startsWith("docker run"));
    expect(runs).toHaveLength(2);
    expect(runs.every((call) => call.includes("-p 127.0.0.1::8123 "))).toBe(true);
    expect(runs.every((call) => call.includes("-e HEALTH_PORT=8123 "))).toBe(true);
    // Existing containers without HEALTH_PORT still listen on their default.
    expect(r.calls.filter((call) => call.startsWith("docker port abc "))).toEqual([
      "docker port abc 8099/tcp", "docker port abc 8099/tcp",
    ]);
  });

  it.each(["0", "65536", "abc", "8099:8099", "-1"])("invalid internal health port %s fails before touching Docker", (port) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_PORT: port });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("HEALTH_PORT must be an integer");
  });
});

describe("install/upgrade command dispatch", () => {
  it("no arguments still use .env and match an explicit vox_agent command", () => {
    fs.copyFileSync(path.join(dir, "agent.env"), path.join(dir, ".env"));
    const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW };
    const implicit = upgrade(env, { defaultEnv: true });
    const explicit = upgrade(env, { command: true, defaultEnv: true });
    expect(implicit.status).toBe(0);
    expect(explicit.status).toBe(0);
    expect(implicit.calls).toEqual(explicit.calls);
  });

  it("no arguments install latest on a new host using .env in the current directory", () => {
    fs.copyFileSync(path.join(dir, "agent.env"), path.join(dir, ".env"));
    const r = upgrade({}, { defaultEnv: true, answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["rm", "run"]);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:latest");
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(run).toContain("AGENT_TOKEN=evtest");
    expect(run).toContain("VOX_SERVER=http://localhost:5000");
    expect(run?.endsWith(` ${AGENT_REF}`)).toBe(true);
  });

  it.each([false, true])("--env selects the specified file with spaces (implicit command: %s)", (implicit) => {
    const envFile = path.join(dir, "agent config.env");
    fs.copyFileSync(path.join(dir, "agent.env"), envFile);
    fs.writeFileSync(path.join(dir, ".env"), "RUNNER_TOKEN=wrong-default\n");
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW }, {
      defaultEnv: true, command: !implicit, args: ["--env", envFile],
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:latest");
    expect(r.calls.join("\n")).not.toContain("vox-clash-runner");
    expect(r.actions).toEqual([]);
  });

  it("vox_agent also installs a new agent when no container exists", () => {
    const r = upgrade({}, { command: true, answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["rm", "run"]);
    expect(r.out).toContain("Starting new container");
  });

  it("positional env-file invocations still match vox_agent for agents and runners", () => {
    for (const runner of [false, true]) {
      const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW };
      expect(upgrade(env, { runner }).calls).toEqual(upgrade(env, { runner, command: true }).calls);
    }
  });
});

describe("selected Docker image versions and rollback", () => {
  it.each([
    ["--version", "c64ff76", "--env"],
    ["--env", "--version", "c64ff76"],
    ["--env=", "--version=c64ff76"],
  ])("accepts explicit --env and --version in either order: %j", (...options) => {
    const envFile = path.join(dir, "agent.env");
    const args = options.flatMap((option) => option === "--env" ? [option, envFile] : option === "--env=" ? [`--env=${envFile}`] : [option]);
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW }, { defaultEnv: true, command: true, args });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:c64ff76");
    expect(r.calls.join("\n")).not.toContain(":latest");
    expect(r.actions).toEqual([]);
  });

  it("still pulls latest by default and launches the verified official named digest", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW }, { command: true });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:latest");
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ${AGENT_REF}`)).toBe(true);
  });

  it.each([false, true])("selects a published image tag (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD }, { command: true, runner, version: "7c3b1a2" });
    const image = `ghcr.io/agora-build/${runner ? "vox-clash-runner" : "vox-eval-agentd"}:7c3b1a2`;
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker pull ${image}`);
    expect(r.calls).toContain(`docker image inspect ${image} --format={{.Id}}`);
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ${runner ? RUNNER_REF : AGENT_REF}`)).toBe(true);
    expect(r.calls.join("\n")).not.toContain(":latest");
    expect(r.out).toContain(`Verified ${image}`);
  });

  it("installs a specific version on a new host after confirmation", () => {
    const r = upgrade({}, { command: true, version: "7c3b1a2", answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["rm", "run"]);
    expect(r.out).toContain("Starting new container");
    expect(r.out).toContain("vox-eval-agentd:7c3b1a2");
  });

  it("rolls back to an older image, preserving existing Docker configuration", () => {
    const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_OLD, DIALF_SOCKET: sock };
    const r = upgrade(env, { command: true, version: "previous-build" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(run).toContain("--restart unless-stopped");
    expect(run).toContain("vox-aeval-cache:/root/.cache");
    expect(run).toContain(`-v ${sock}:${sock}`);
    expect(run?.endsWith(` ghcr.io/agora-build/vox-eval-agentd@${MANIFEST_OLD}`)).toBe(true);
    expect(r.out).toContain("vox-eval-agentd:previous-build");
    expect(r.out).toContain("Selected image differs from running image");
  });

  it("accepts an immutable manifest digest using Docker's @ syntax", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const r = upgrade({ RUNNING_ID: "abc" }, { command: true, version: digest });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker pull ghcr.io/agora-build/vox-eval-agentd@${digest}`);
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ghcr.io/agora-build/vox-eval-agentd@${digest}`)).toBe(true);
  });

  it("does not replace a container already running the selected version", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW }, { command: true, version: "7c3b1a2" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("Already running the selected image (ghcr.io/agora-build/vox-eval-agentd:7c3b1a2)");
  });

  it("allows --version before the env file and the --version=tag form", () => {
    const env = { RUNNING_ID: "abc" };
    fs.copyFileSync(path.join(dir, "agent.env"), path.join(dir, ".env"));
    const beforeEnv = upgrade(env, { defaultEnv: true, command: true, args: ["--version", "7c3b1a2", path.join(dir, "agent.env")] });
    const equals = upgrade(env, { command: true, args: ["--version=7c3b1a2"] });
    const implicit = upgrade(env, { defaultEnv: true, args: ["--version", "7c3b1a2"] });
    expect(beforeEnv.status).toBe(0);
    expect(equals.status).toBe(0);
    expect(implicit.status).toBe(0);
    expect(beforeEnv.calls).toEqual(equals.calls);
    expect(implicit.calls).toEqual(equals.calls);
  });

  it("an unavailable version leaves the existing container untouched", () => {
    const r = upgrade({ RUNNING_ID: "abc", PULL_FAIL_IMAGE: "vox-eval-agentd" }, { command: true, version: "missing-build" });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
    expect(r.calls.some((call) => call.startsWith("docker image inspect"))).toBe(false);
  });

  it("a failed image inspection leaves the existing container untouched", () => {
    const r = upgrade({ RUNNING_ID: "abc", TARGET_INSPECT_FAIL: "1" }, { command: true, version: "7c3b1a2" });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("could not resolve");
  });

  it.each(["", "invalid-image", "--privileged", "sha256:short"])("rejects invalid resolved image ID %j before changing containers", (id) => {
    const r = upgrade({ RUNNING_ID: "abc", LATEST_IMAGE: id }, { command: true });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
  });

  it("validates both selected images before any replacement", () => {
    const r = upgrade({ RUNNING_ID: "abc" }, { command: true, both: true, version: "7c3b1a2" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:7c3b1a2");
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-clash-runner:7c3b1a2");
    const firstStop = r.calls.findIndex((call) => call.startsWith("docker stop"));
    const inspections = r.calls.flatMap((call, index) => call.startsWith("docker image inspect") ? [index] : []);
    expect(inspections).toHaveLength(6);
    expect(inspections.every((index) => index < firstStop)).toBe(true);
  });

  it("keeps agent and runner image IDs separate when both use the same tag", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNER_TARGET_IMAGE: IMAGE_OLD }, { command: true, both: true, version: "7c3b1a2" });
    expect(r.status).toBe(0);
    const runs = r.calls.filter((call) => call.startsWith("docker run"));
    // The runner already has IMAGE_OLD; only the agent needs replacement.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--name vox-eval-agentd");
    expect(runs[0].endsWith(` ${AGENT_REF}`)).toBe(true);
    expect(r.out).toContain("Already running the selected image (ghcr.io/agora-build/vox-clash-runner:7c3b1a2)");
  });

  it("a missing second image cannot leave a multi-container rollback half-applied", () => {
    const r = upgrade({ RUNNING_ID: "abc", PULL_FAIL_AT: "2" }, { command: true, both: true, version: "missing-build" });
    expect(r.status).toBe(1);
    expect(r.calls.filter((call) => call.startsWith("docker pull"))).toHaveLength(2);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
  });
});

describe("hosts WITH DialF", () => {
  it("preserves the cache and read-only network directory alongside DialF mounts", () => {
    const statusDir = path.join(dir, "network-status");
    fs.mkdirSync(statusDir);
    fs.writeFileSync(path.join(statusDir, "status.json"), "{}");
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, DIALF_SOCKET: sock, VOX_NETWORK_STATUS_DIR: statusDir });
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(r.status).toBe(0);
    expect(run).toContain(`-v ${statusDir}:/run/vox-network:ro`);
    expect(run).toContain("VOX_NETWORK_STATUS_FILE=/run/vox-network/status.json");
    expect(run).toContain("vox-aeval-cache:/root/.cache");
    expect(run).toContain(`-v ${sock}:${sock}`);
  });
  it("same image, but the running container lacks the DialF mount: recreated with it", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_NEW, DIALF_SOCKET: sock });
    expect(r.out).toMatch(/wasn't started with it — recreating it/);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain(`VOX_DIALF_SOCKET=${sock}`);
  });

  it("same path but dialfd recreated its socket (stale inode): restarted, and the new check read since then", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_NEW, PREV_SOCK: sock, DIALF_SOCKET: sock, CONT_INO: "1", PROBE_LINE: "[Daemon] DialF probe: ok (v0.3.16)" });
    expect(r.out).toMatch(/DialF socket is stale/);
    expect(r.actions).toEqual(["restart"]);
    // Unix seconds, not a bare datetime (which Docker reads as LOCAL time).
    expect(r.calls.some((c) => /^docker logs --since \d{10} abc$/.test(c))).toBe(true);
    expect(r.out).toMatch(/DialF check inside the container: OK/);
  });

  it("same path, same inode: left alone (no needless restart)", () => {
    const ino = String(fs.statSync(sock).ino);
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_NEW, PREV_SOCK: sock, DIALF_SOCKET: sock, CONT_INO: ino });
    expect(r.actions).toEqual([]);
    expect(r.out).toMatch(/Already running the selected image/);
  });

  it("the old container had DialF and none is found now: asks BEFORE stopping it, and 'n' leaves it running", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, PREV_SOCK: "/run/user/1001/dialfd.sock" }, { answers: "n\n" });
    expect(r.out).toMatch(/WON'T take phone jobs/);
    expect(r.out).toMatch(/Leaving the running vox-eval-agentd as it is/);
    expect(r.actions).toEqual([]);
  });

  it("reports what the agent's own DialF check says after launch — e.g. no permission", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, DIALF_SOCKET: sock, PROBE_LINE: "[Daemon] DialF probe: unavailable (no permission to open the dialfd socket x)" });
    expect(r.out).toMatch(/WARNING: DialF check inside the container FAILED: unavailable \(no permission to open the dialfd socket x\)/);
  });
});

describe("VOX_LINK_TYPE (network tags — host link detection, design 2026-10-22)", () => {
  it("a known VOX_LINK_TYPE in the environment is passed to the agent container", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_LINK_TYPE: "wifi" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_LINK_TYPE=wifi");
  });

  it("an invalid VOX_LINK_TYPE is ignored — not forwarded (host_link_type falls through, finds nothing here)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_LINK_TYPE: "5g" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });

  it("unset VOX_LINK_TYPE and no real route (stub ip): nothing forwarded, run unaffected", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });

  it("not forwarded to vox-clash-runner (it doesn't report network tags)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_LINK_TYPE: "wifi" }, { runner: true });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });
});

describe("VOX_PUBLIC_IP_ON_IFACE (network tags part 2 — host interface detection, design 2026-10-22)", () => {
  it("a known VOX_PUBLIC_IP_ON_IFACE in the environment is passed to the agent container", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_PUBLIC_IP_ON_IFACE: "true" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_PUBLIC_IP_ON_IFACE=true");
  });

  it("false is passed through too (not just truthy values)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_PUBLIC_IP_ON_IFACE: "false" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_PUBLIC_IP_ON_IFACE=false");
  });

  it("an invalid VOX_PUBLIC_IP_ON_IFACE is ignored — not forwarded (host_public_ip_on_iface falls through, finds nothing here)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_PUBLIC_IP_ON_IFACE: "maybe" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
  });

  it("unset VOX_PUBLIC_IP_ON_IFACE and no real route (stub ip): nothing forwarded, run unaffected", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
  });

  // The script's own address classifier, run on its own (extracted from the
  // real script): only IPv4 counts. Dual-stack homes and IPv6 hotspots hold
  // global 2000::/3 addresses, which say nothing about a home router.
  const classify = (out: string) => {
    const fn = fs.readFileSync(SCRIPT, "utf8").match(/^host_addr_is_public\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(fn).toBeTruthy();
    return spawnSync("bash", ["-c", `${fn}\nhost_addr_is_public "$1"`, "_", out], { encoding: "utf8" }).status;
  };
  it("host_addr_is_public: public IPv4 → 0, private/CGNAT IPv4 → 1", () => {
    expect(classify("2: eth0    inet 203.0.113.5/24 scope global eth0")).toBe(0);
    expect(classify("2: eth0    inet 192.168.1.5/24 scope global eth0")).toBe(1);
    expect(classify("2: eth0    inet 100.90.1.5/10 scope global eth0")).toBe(1);
  });
  it("host_addr_is_public: home dual-stack (RFC1918 v4 + global v6) → 1, not public", () => {
    expect(classify("2: eth0    inet 192.168.1.5/24 scope global eth0\n2: eth0    inet6 2601:646:8a00:1f0::5/128 scope global dynamic")).toBe(1);
  });
  it("host_addr_is_public: IPv6-only host → 2 (undetermined), so nothing is forwarded", () => {
    expect(classify("2: eth0    inet6 2001:db8::1/64 scope global")).toBe(2);
  });

  it("not forwarded to vox-clash-runner (it doesn't report network tags)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, VOX_PUBLIC_IP_ON_IFACE: "true" }, { runner: true });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
  });
});

describe("permission problems are reported, not guessed at", () => {
  it("no permission to use Docker: stops before touching any container", () => {
    const r = upgrade({ DOCKER_DENIED: "1", RUNNING_ID: "abc" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no permission to use Docker as user/);
    expect(r.actions).toEqual([]);
    expect(r.calls.some((c) => c.startsWith("docker pull"))).toBe(false);
  });

  it("dialfd runs as another user, so its socket isn't visible: says so, naming both users", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, PS_DIALF_UID: "4321" });
    expect(r.out).toMatch(/dialfd is running as '(uid 4321|[^']+)', but this script runs as '.+' and has no permission to see/);
  });

  it("dialfd running as THIS user (by UID — a long name is truncated by ps) is not called a permission problem", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, PS_DIALF_UID: String(process.getuid?.() ?? 1000) });
    expect(r.out).toMatch(/dialfd is running, but its socket isn't in the usual places/);
    expect(r.out).not.toMatch(/no permission to see/);
  });

  it("DIALF_SOCKET set but nothing listening: names the setting, not generic advice", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, DIALF_SOCKET: path.join(dir, "nope.sock") });
    expect(r.out).toMatch(/DIALF_SOCKET=.*nope\.sock is set, but nothing is listening there/);
  });

  it("a failing docker inspect mid-run doesn't abort the upgrade (set -euo pipefail)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, INSPECT_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.actions).toContain("run");
  });

  it("…nor does a failing image inspect (#250 review)", () => {
    const r = upgrade({ RUNNING_ID: "abc", LATEST_IMAGE: IMAGE_NEW, IMAGE_INSPECT_FAIL: "1" });
    expect(r.calls.some((c) => c.includes("{{.Image}}"))).toBe(true);
    // It carries on (an unknown image counts as "not the latest") and upgrades.
    expect(r.status).toBe(0);
    expect(r.actions).toContain("run");
  });

  it("the DialF prompt with no terminal (EOF) answers no: the running container is left alone, the run doesn't die", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW, PREV_SOCK: "/run/user/1001/dialfd.sock" }, { answers: "" });
    expect(r.out).toMatch(/Leaving the running vox-eval-agentd as it is/);
    expect(r.actions).toEqual([]);
    expect(r.status).toBe(0);
  });
});

describe("the agent's DialF check names why it can't open the socket", () => {
  it("no socket at the path", async () => {
    const reason = (await probeDialf(path.join(dir, "never-existed.sock"))).reason;
    expect(reason).toMatch(/^no dialfd socket at the configured path — dialfd isn't running/);
    // No host path in the reason: it can reach a marketplace job's error (#250 review).
    expect(reason).not.toContain(dir);
  });

  it("a socket this user has no permission to open", async () => {
    if (process.getuid?.() === 0) return; // root bypasses file permissions
    const locked = path.join(dir, "locked.sock");
    const s = net.createServer().listen(locked);
    await new Promise((r) => s.once("listening", r));
    fs.chmodSync(locked, 0o000);
    try {
      const reason = (await probeDialf(locked)).reason;
      expect(reason).toMatch(/^no permission to open the dialfd socket — it belongs to the user running dialfd/);
      expect(reason).not.toContain(dir);
    } finally {
      s.close();
    }
  });

  it("a dead dialfd's leftover socket (nothing listening): dialfd stopped or restarted", async () => {
    // Bound by a process that has exited: the file stays, nothing listens.
    const stale = path.join(dir, "stale.sock");
    execFileSync("python3", ["-c", `import socket; socket.socket(socket.AF_UNIX).bind(${JSON.stringify(stale)})`]);
    expect(fs.statSync(stale).isSocket()).toBe(true);
    expect((await probeDialf(stale)).reason).toMatch(/^dialfd isn't listening on its socket — it stopped or restarted/);
  });

  it("anything else still names the code", () => {
    expect(dialfConnectFailure(Object.assign(new Error("boom"), { code: "EWHAT" }))).toBe("dialfd socket unreachable (EWHAT)");
  });
});

describe("interface names from route output are validated before use (PR #258 round 3)", () => {
  const validIface = (name: string) => {
    const fn = fs.readFileSync(SCRIPT, "utf8").match(/^valid_iface_name\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(fn).toBeTruthy();
    return spawnSync("bash", ["-c", `${fn}\nvalid_iface_name "$1"`, "_", name], { encoding: "utf8" }).status;
  };
  it("valid_iface_name: real names pass, metacharacters / traversal / options / overlong fail", () => {
    for (const ok of ["eth0", "wlp3s0", "veth1@if5", "eth0.100", "eth0:1", "en0", "enp0s31f6"]) expect(validIface(ok)).toBe(0);
    for (const bad of ["", ".", "..", "-v", "eth0;id", "eth0$(id)", "a/b", "eth0`id`", "a".repeat(33), "eth0\nwlan0"]) expect(validIface(bad)).not.toBe(0);
  });

  it("a hostile default-route interface name is never passed to ip addr and nothing is forwarded", () => {
    const r = upgrade({
      RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW,
      IP_ROUTE_OUT: "1.1.1.1 via 192.168.1.1 dev eth0;touch$IFS/tmp/pwned src 192.168.1.5",
      IP_ADDR_OUT: "2: eth0    inet 203.0.113.5/24 scope global eth0",
    });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("ip ")).every((c) => c === "ip route get 1.1.1.1")).toBe(true);
    const run = r.calls.find((c) => c.startsWith("docker run"));
    expect(run).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
    expect(run).not.toContain("VOX_LINK_TYPE");
  });

  it("a valid name is used (quoted, one argument) and its answer forwarded", () => {
    const r = upgrade({
      RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW,
      IP_ROUTE_OUT: "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5",
      IP_ADDR_OUT: "2: eth0    inet 203.0.113.5/24 scope global eth0",
    });
    expect(r.calls).toContain("ip -o addr show dev eth0");
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_PUBLIC_IP_ON_IFACE=true");
  });
});
