import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { dialfConnectFailure, probeDialf } from "../vox_eval_agentd/dialf-client";

// Run the manager against recorded Docker stubs and a real Unix socket for DialF.

const SCRIPT = path.resolve(__dirname, "../scripts/vox-manager.sh");
const IMAGE_NEW = `sha256:${"a".repeat(64)}`;
const IMAGE_OLD = `sha256:${"b".repeat(64)}`;
const MANIFEST_NEW = `sha256:${"c".repeat(64)}`;
const MANIFEST_OLD = `sha256:${"d".repeat(64)}`;
const AGENT_REF = `ghcr.io/agora-build/vox-eval-agentd@${MANIFEST_NEW}`;
const RUNNER_REF = `ghcr.io/agora-build/vox-clash-runner@${MANIFEST_NEW}`;
const CONTAINER_NEW = `${"0".repeat(63)}1`;
let dir = "";
let sock = "";
let sockServer: net.Server;
const shellValue = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const CAPTURE_CHILD_ENV = `if [ -n "\${VU_CHILD_ENVS:-}" ]; then
  printf '%s\\0' "\${0##*/}" >> "$VU_CHILD_ENVS"
  /usr/bin/env -0 >> "$VU_CHILD_ENVS"
  printf '\\0' >> "$VU_CHILD_ENVS"
fi
`;

const STUB_DOCKER = `#!/bin/bash
${CAPTURE_CHILD_ENV}
echo "docker $*" >> "$VU_LOG"
printf '%s\\0' "$@" '' >> "$VU_ARGV"
case "$1" in
  info) [ -n "\${DOCKER_DENIED:-}" ] && { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }; echo ok ;;
  ps)
    [ -n "\${PS_FAIL:-}" ] && exit 1
    if [ -n "\${VU_CONTAINERS:-}" ]; then cat "$VU_CONTAINERS/inventory"
    else
      existing="\${EXISTING_ID:-\${RUNNING_ID:-}}"
      [ -n "$existing" ] && echo "$existing"
      [ -n "$existing" ] && [ -n "\${VU_BOTH:-}" ] && echo "runner-$existing"
    fi
    exit 0 ;;
  pull)
    [ -n "\${PULL_FAIL_IMAGE:-}" ] && [[ "$2" == *"$PULL_FAIL_IMAGE"* ]] && exit 1
    [ -n "\${PULL_FAIL_AT:-}" ] && [ "$(grep -c '^docker pull' "$VU_LOG")" = "$PULL_FAIL_AT" ] && exit 1
    exit 0 ;;
  image)
    [ -n "\${TARGET_INSPECT_FAIL:-}" ] && exit 1
    if [[ "$*" == *RepoTags* ]]; then
      [ -n "\${ALIAS_INSPECT_FAIL:-}" ] && exit 1
      if [ -f "\${VU_CONTAINERS:-}/$3.aliases" ]; then cat "$VU_CONTAINERS/$3.aliases"
      else printf 'ghcr.io/agora-build/vox-eval-agentd:previous-build\\nghcr.io/agora-build/vox-clash-runner:previous-build\\n'; fi
      exit 0
    fi
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
    inspected_id="\${!#}"
    case "$*" in
      *"{{.Name}}"*)
        [ -n "\${DISCOVERY_INSPECT_FAIL:-}" ] && exit 1
        if [ "$3" = '{{.Name}}' ]; then
          [ -n "\${ORIGINAL_NAME_FAIL:-}" ] && exit 1
          if [ -n "\${VU_CONTAINERS:-}" ]; then head -1 "$VU_CONTAINERS/$inspected_id.meta"
          else
            component="$VU_COMPONENT"
            [[ "$inspected_id" == runner-* ]] && component=vox-clash-runner
            echo "/$component"
          fi
          exit 0
        fi
        if [ -n "\${VU_CONTAINERS:-}" ]; then cat "$VU_CONTAINERS/$inspected_id.meta"
        else
          component="$VU_COMPONENT"
          [[ "$inspected_id" == runner-* ]] && component=vox-clash-runner
          state=$(printf '%s\\n' "\${DOCKER_STATES:-running}" | head -1)
          printf '/%s\\nghcr.io/agora-build/%s:previous-build\\n%s\\n%s\\n' "$component" "$component" "\${RUNNING_IMAGE:-${IMAGE_OLD}}" "$state"
        fi ;;
      *"State.Status"*)
        if [ -f "$VU_ENV_FILES/$inspected_id.created" ]; then
          [ -n "\${NEW_STATE_INSPECT_FAIL:-}" ] && exit 1
          echo "\${NEW_STATE:-running}"
          exit 0
        fi
        [ -n "\${STATE_INSPECT_FAIL:-}" ] && exit 1
        attempt=$(grep -c '^docker inspect --format {{.State.Status}} ' "$VU_LOG")
        states="\${DOCKER_STATES:-running}"
        state=$(printf '%s\\n' "$states" | sed -n "\${attempt}p")
        [ -n "$state" ] || state=$(printf '%s\\n' "$states" | tail -1)
        echo "$state" ;;
      *"{{.Image}}"*) [ -n "\${IMAGE_INSPECT_FAIL:-}" ] && exit 1; echo "\${RUNNING_IMAGE:-${IMAGE_OLD}}" ;;
      *"Config.Env"*)
        [ -n "\${INSPECT_FAIL:-}" ] && exit 1
        if [ -n "\${VU_CONTAINERS:-}" ]; then cat "$VU_CONTAINERS/$inspected_id.env"
        else
          [ -n "\${PREV_SOCK:-}" ] && echo "VOX_DIALF_SOCKET=$PREV_SOCK"
          [ -n "\${PREV_HEALTH_PORT:-}" ] && echo "HEALTH_PORT=$PREV_HEALTH_PORT"
          printf 'AGENT_TOKEN=evtest\\nRUNNER_TOKEN=crtest\\n'
        fi ;;
      *"RestartPolicy"*) echo "\${CURRENT_RESTART_POLICY:-unless-stopped}" ;;
      *"NetworkSettings"*) echo "\${CONTAINER_IP:-}" ;;
      *) echo "" ;;
    esac ;;
  exec) case "$*" in
    *stat*) [ -n "\${CONT_INO:-}" ] && echo "$CONT_INO" || exit 1 ;;
    *"grep -q VirtualAudio /proc/asound/cards"*) [ "\${CONTAINER_AUDIO:-present}" = present ] ;;
    *) exit 0 ;;
  esac ;;
  logs) [ -n "\${PROBE_LINE:-}" ] && echo "$PROBE_LINE"; echo "[Daemon] Heartbeat sent" ;;
  port) [ -z "\${NO_HEALTH_MAPPING:-}" ] && echo "\${HEALTH_MAPPING:-127.0.0.1:49152}" ;;
  stop) [ -z "\${STOP_FAIL:-}" ] ;;
  restart) [ -z "\${RESTART_FAIL:-}" ] ;;
  update) [ -z "\${UPDATE_FAIL:-}" ] ;;
  rename)
    attempt=$(grep -c '^docker rename' "$VU_LOG")
    [ "$attempt" != "\${RENAME_FAIL_AT:-}" ] ;;
  rm) [ -z "\${OLD_RM_FAIL:-}" ] || [ "$2" = -f ] ;;
  run)
    attempt=$(grep -c '^docker run' "$VU_LOG")
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = --env-file ]; then
        next=$((i+1)); token_file="\${!next}"
        cp -- "$token_file" "$VU_ENV_FILES/$attempt.env" || exit 125
        printf '%s' "$token_file" > "$VU_ENV_FILES/$attempt.path"
        stat -c '%a' -- "$token_file" > "$VU_ENV_FILES/$attempt.mode"
        stat -c '%a' -- "\${token_file%/*}" > "$VU_ENV_FILES/$attempt.dir-mode"
      fi
    done
    { [ -n "\${RUN_FAIL:-}" ] || [ "$attempt" = "\${RUN_FAIL_AT:-}" ]; } && exit 125
    candidate_id=$(printf '%064x' "$attempt")
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = --cidfile ]; then
        next=$((i+1)); cidfile="\${!next}"
        if [ -z "\${CID_FILE_MISSING:-}" ]; then printf '%s' "\${CID_FILE_CONTENT-$candidate_id}" > "$cidfile"; fi
      fi
    done
    touch "$VU_ENV_FILES/$candidate_id.created"
    [ -n "\${RUN_SIGNAL:-}" ] && { kill -s "$RUN_SIGNAL" "$PPID"; exit 143; }
    [ -n "\${RUN_PARTIAL_FAIL:-}" ] && exit 125
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
    echo "$candidate_id" ;;
  *) ;;
esac
`;
const STUB_CURL = `#!/bin/bash
${CAPTURE_CHILD_ENV}
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
${CAPTURE_CHILD_ENV}
if [ "$*" = "-o uid= -C dialfd" ]; then [ -n "\${PS_DIALF_UID:-}" ] && echo "  $PS_DIALF_UID"; exit 0; fi
exec /usr/bin/ps "$@"
`;
// No real network detection: tests supply route/address output or env overrides.
const STUB_IP = `#!/bin/bash
${CAPTURE_CHILD_ENV}
echo "ip $*" >> "$VU_LOG"
if [ "$1" = "route" ] && [ -n "\${IP_ROUTE_OUT:-}" ]; then echo "$IP_ROUTE_OUT"; exit 0; fi
if [ "$1" = "-o" ] && [ -n "\${IP_ADDR_OUT:-}" ]; then echo "$IP_ADDR_OUT"; exit 0; fi
exit 1
`;
const STUB_MKTEMP = `#!/bin/bash
${CAPTURE_CHILD_ENV}
[ -n "\${ENV_TEMP_FAIL:-}" ] && exit 1
exec /usr/bin/mktemp "$@"
`;
const STUB_BASH = `#!/bin/bash
if [ "\${1:-}" = -n ]; then
${CAPTURE_CHILD_ENV}
fi
exec /bin/bash "$@"
`;
const STUB_GREP = `#!/bin/bash
if [ "$#" = 3 ] && [ "$1" = -q ] && [ "$2" = VirtualAudio ] && [ "$3" = /proc/asound/cards ]; then
  [ "\${HOST_AUDIO:-present}" = present ]; exit $?
fi
command -p grep "$@"
`;
const STUB_SYSTEMCTL = `#!/bin/bash
if [ "$*" = 'is-enabled docker' ]; then
  [ "\${DOCKER_BOOT_ENABLED:-true}" = true ]; exit $?
fi
exit 1
`;

type ContainerFixture = { id: string; name: string; ref: string; imageId?: string; state?: string; env?: string[]; aliases?: string[] };
function upgrade(env: Record<string, string>, opts: { runner?: boolean; both?: boolean; answers?: string; command?: boolean; defaultEnv?: boolean; versions?: { eval?: string; clash?: string }; args?: string[]; containers?: ContainerFixture[]; permissiveUmask?: boolean; inspectEnvs?: boolean } = {}) {
  const log = path.join(dir, `calls-${Math.random()}.log`);
  fs.writeFileSync(log, "");
  const argvLog = `${log}.argv`;
  fs.writeFileSync(argvLog, "");
  const childEnvLog = `${log}.child-envs`;
  fs.writeFileSync(childEnvLog, "");
  const envCaptures = `${log}.env-files`;
  fs.mkdirSync(envCaptures);
  const tempRoot = env.TMPDIR ?? `${log}.tmp`;
  fs.mkdirSync(tempRoot, { recursive: true });
  let containersDir = "";
  if (opts.containers) {
    containersDir = `${log}.containers`;
    fs.mkdirSync(containersDir);
    fs.writeFileSync(path.join(containersDir, "inventory"), opts.containers.map((c) => c.id).join("\n"));
    for (const container of opts.containers) {
      const imageId = container.imageId ?? IMAGE_OLD;
      fs.writeFileSync(path.join(containersDir, `${container.id}.meta`), `/${container.name}\n${container.ref}\n${imageId}\n${container.state ?? "running"}\n`);
      fs.writeFileSync(path.join(containersDir, `${container.id}.env`), (container.env ?? []).join("\n"));
      if (container.aliases) fs.writeFileSync(path.join(containersDir, `${imageId}.aliases`), container.aliases.join("\n"));
    }
  }
  let envFile = path.join(dir, opts.both ? "both.env" : opts.runner ? "runner.env" : "agent.env");
  if (opts.versions) {
    const versionSettings = Object.entries(opts.versions).map(([service, version]) => `${service === "eval" ? "EVAL_VERSION" : "CLASH_VERSION"}=${shellValue(version)}`).join("\n");
    const configuredEnvFile = `${log}.env`;
    fs.writeFileSync(configuredEnvFile, `${fs.readFileSync(envFile, "utf8")}\n${versionSettings}\n`);
    envFile = configuredEnvFile;
  }
  const args = opts.defaultEnv ? (opts.command ? ["vox_agent"] : []) : opts.command ? ["vox_agent", envFile] : [envFile];
  if (opts.args) args.push(...opts.args);
  const bashArgs = opts.permissiveUmask ? ["-c", 'umask 000; exec bash "$@"', "_", SCRIPT, ...args] : [SCRIPT, ...args];
  const r = spawnSync("bash", bashArgs, {
    cwd: dir,
    input: opts.answers ?? "",
    encoding: "utf8",
    env: {
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, TMPDIR: tempRoot,
      VU_LOG: log, VU_ARGV: argvLog, VU_ENV_FILES: envCaptures,
      VU_CHILD_ENVS: opts.inspectEnvs ? childEnvLog : "",
      VU_COMPONENT: opts.runner ? "vox-clash-runner" : "vox-eval-agentd", VU_BOTH: opts.both ? "1" : "", VU_CONTAINERS: containersDir,
      XDG_RUNTIME_DIR: path.join(dir, "no-runtime"), DIALF_CHECK_TRIES: "1", ...env,
    },
    timeout: 30_000,
  });
  expect(r.error).toBeUndefined();
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const actions = calls.filter((c) => /^docker (stop|rm|run|restart)\b/.test(c)).map((c) => c.split(" ")[1]);
  const argvCalls = fs.readFileSync(argvLog, "utf8").split("\0\0").filter(Boolean).map((call) => call.split("\0"));
  const childEnvs = fs.readFileSync(childEnvLog, "utf8").split("\0\0").filter(Boolean).map((entry) => {
    const [command, ...environment] = entry.split("\0");
    return { command, environment };
  });
  const tokenFiles = fs.readdirSync(envCaptures).filter((file) => file.endsWith(".env")).sort().map((file) => {
    const base = path.join(envCaptures, file.slice(0, -4));
    return {
      content: fs.readFileSync(`${base}.env`, "utf8"), path: fs.readFileSync(`${base}.path`, "utf8"),
      mode: fs.readFileSync(`${base}.mode`, "utf8").trim(), directoryMode: fs.readFileSync(`${base}.dir-mode`, "utf8").trim(),
    };
  });
  const comparableCalls = calls.map((call) => tokenFiles.reduce((value, file) => value
    .replaceAll(path.dirname(file.path), "<private-dir>")
    .replaceAll(path.basename(path.dirname(file.path)), "<private-dir>"), call));
  return { out: `${r.stdout}${r.stderr}`, status: r.status, calls, comparableCalls, actions, argvCalls, childEnvs, tokenFiles, tempEntries: fs.readdirSync(tempRoot) };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-manager-dialf-test-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ps"), STUB_PS, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ip"), STUB_IP, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "mktemp"), STUB_MKTEMP, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "bash"), STUB_BASH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "grep"), STUB_GREP, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "systemctl"), STUB_SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "curl"), STUB_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "sleep"), '#!/bin/bash\necho "sleep $*" >> "$VU_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "agent.env"), "EVAL_TOKEN=evtest\nVOX_SERVER=http://localhost:5000\n");
  fs.writeFileSync(path.join(dir, "runner.env"), "CLASH_TOKEN=crtest\nVOX_SERVER=http://localhost:5000\n");
  fs.writeFileSync(path.join(dir, "both.env"), "EVAL_TOKEN=evtest\nCLASH_TOKEN=crtest\nVOX_SERVER=http://localhost:5000\n");
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
      expect(after.actions).toEqual(env.RUNNING_IMAGE === env.LATEST_IMAGE ? [] : ["stop", "run", "rm"]);
      expect(after.actions).toEqual(before.actions);
      const runOf = (r: typeof after) => r.argvCalls.find((args) => args[0] === "run")?.map((arg, index, args) => ["--env-file", "--cidfile"].includes(args[index - 1]) ? "<private-file>" : arg);
      expect(runOf(after)).toEqual(runOf(before));
      expect(after.tokenFiles.map((file) => file.content)).toEqual(before.tokenFiles.map((file) => file.content));
      expect(after.out).not.toMatch(/WARNING|Restart required|recreat|Continue|\(y\/n\)/);
    });
  }
});

describe("host prerequisite warnings", () => {
  it.each(["true", "false"])("reports Docker boot configuration independently of upgrades (enabled=%s)", (enabled) => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, DOCKER_BOOT_ENABLED: enabled });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out.includes("WARNING: the Docker service is NOT enabled at boot")).toBe(enabled === "false");
  });

  it("warns when the host lacks VirtualAudio without hiding a successful upgrade", () => {
    const r = upgrade({ RUNNING_ID: "abc", HOST_AUDIO: "missing" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain("WARNING: no VirtualAudio ALSA card on this host");
    expect(r.out).not.toContain("Audio check: VirtualAudio visible inside the container");
  });

  it("distinguishes a missing container card from a missing host card", () => {
    const r = upgrade({ RUNNING_ID: "abc", CONTAINER_AUDIO: "missing" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain("WARNING: VirtualAudio is NOT visible INSIDE the container");
    expect(r.out).not.toContain("WARNING: no VirtualAudio ALSA card on this host");
  });

  it("keeps phone-only guidance when DialF exists but host VirtualAudio does not", () => {
    const r = upgrade({ RUNNING_ID: "abc", DIALF_SOCKET: sock, HOST_AUDIO: "missing" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("NOTE: no VirtualAudio ALSA card");
    expect(r.out).toContain("Phone vs Agent jobs are unaffected");
    expect(r.out).not.toContain("WARNING: no VirtualAudio ALSA card on this host");
  });
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
    const r = upgrade({ RUNNING_ID: "abc" }, { runner, versions: { eval: version, clash: version } });
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

describe("version-independent legacy discovery", () => {
  function legacy(id: string, runner = false, overrides: Partial<ContainerFixture> = {}): ContainerFixture {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    return { id, name: `legacy_${id}`, ref: `ghcr.io/agora-build/${component}:latest`, env: [runner ? "RUNNER_TOKEN=crtest" : "AGENT_TOKEN=evtest"], ...overrides };
  }

  it.each([false, true].flatMap((runner) => ["tag", "digest", "id"].map((kind) => [runner, kind] as const)))("finds a legacy container independently of the rollback version (runner: %s, reference: %s)", (runner, kind) => {
    const repo = `ghcr.io/agora-build/${runner ? "vox-clash-runner" : "vox-eval-agentd"}`;
    const ref = kind === "id" ? IMAGE_OLD : kind === "digest" ? `${repo}@${MANIFEST_OLD}` : `${repo}:latest`;
    const r = upgrade({}, { runner, versions: { eval: "rollback-build", clash: "rollback-build" }, containers: [legacy("older", runner, { ref, aliases: [`${repo}@${MANIFEST_OLD}`] })] });
    expect(r.status).toBe(0);
    expect(r.argvCalls).toContainEqual(["stop", "older"]);
    expect(r.argvCalls).toContainEqual(["rm", "older"]);
    expect(r.calls.some((call) => call.includes("ancestor="))).toBe(false);
    expect(r.calls).toContain(`docker pull ${repo}:rollback-build`);
    expect(r.argvCalls.filter((args) => args[0] === "run")).toHaveLength(1);
  });

  it.each([false, true])("prefers the unique running legacy container over newer exited leftovers (runner: %s)", (runner) => {
    const r = upgrade({}, { runner, containers: [legacy("newer-exited", runner, { state: "exited" }), legacy("older-running", runner)] });
    expect(r.status).toBe(0);
    expect(r.argvCalls.filter((args) => args[0] === "stop" || args[0] === "rm")).toEqual([["stop", "older-running"], ["rm", "older-running"]]);
  });

  it("keeps a managed named container while leaving exited legacy leftovers untouched", () => {
    const r = upgrade({}, { containers: [legacy("named", false, { name: "vox-eval-agentd" }), legacy("old-exited", false, { state: "exited" })] });
    expect(r.status).toBe(0);
    expect(r.argvCalls.filter((args) => args[0] === "stop" || args[0] === "rm")).toEqual([["stop", "named"], ["rm", "named"]]);
  });

  it.each([
    [legacy("one"), legacy("two")],
    [legacy("one", false, { state: "paused" }), legacy("two")],
    [legacy("one", false, { state: "exited" }), legacy("two", false, { state: "exited" })],
    [legacy("one", false, { name: "vox-eval-agentd" }), legacy("two")],
  ])("ambiguous matches fail before any image pull or mutation, even with --force (%j)", (...containers) => {
    const r = upgrade({}, { containers, args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("ambiguous");
    expect(r.out).toContain("No containers were changed");
    expect(r.calls.some((call) => call.startsWith("docker pull"))).toBe(false);
    expect(r.out).not.toContain("evtest");
  });

  it("ambiguity in the second component prevents replacement of either component", () => {
    const r = upgrade({}, { both: true, args: ["--force"], containers: [legacy("agent"), legacy("runner-one", true), legacy("runner-two", true)] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.calls.some((call) => call.startsWith("docker pull"))).toBe(false);
  });

  it.each([
    { ref: "ghcr.io/someone-else/vox-eval-agentd:latest" },
    { ref: "ghcr.io/agora-build/vox-eval-agentd-other:latest" },
    { env: ["AGENT_TOKEN=other-owner-token"] },
  ])("does not adopt another repository or another credential's container (%j)", (overrides) => {
    const r = upgrade({}, { args: ["--force"], containers: [legacy("other-owner", false, overrides)] });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["run"]);
  });

  it("fails closed for a bare-ID container with the configured token but no repository identity", () => {
    const r = upgrade({}, { args: ["--force"], containers: [legacy("unknown", false, { ref: IMAGE_OLD, aliases: [] })] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("image repository is unknown");
  });

  it.each([false, true].flatMap((runner) => ["unrelated-tag", "foreign-repo", "other-component", "unknown-id", "foreign-id", "other-component-id"].map((kind) => [runner, kind] as const)))("managed names require verified repository identity before any pull or mutation (runner: %s, reference: %s)", (runner, kind) => {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    const otherComponent = runner ? "vox-eval-agentd" : "vox-clash-runner";
    const otherRepo = `ghcr.io/agora-build/${otherComponent}:latest`;
    const ref = kind.endsWith("id") ? IMAGE_OLD : kind === "foreign-repo" ? `ghcr.io/someone-else/${component}:latest` : kind === "other-component" ? otherRepo : "unrelated:latest";
    const aliases = kind === "foreign-id" ? ["unrelated:latest"] : kind === "other-component-id" ? [otherRepo] : [];
    const r = upgrade({}, { runner, args: ["--force"], containers: [legacy("unrelated", runner, { name: component, ref, aliases })] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("belongs to another image");
    expect(r.out).toContain("No containers were changed");
    expect(r.argvCalls.some((args) => args[0] === "pull" || args[0] === "update")).toBe(false);
  });

  it.each([false, true].flatMap((runner) => ["tag", "digest", "id-tag", "id-digest"].map((kind) => [runner, kind] as const)))("accepts a managed name with verified official repository metadata (runner: %s, reference: %s)", (runner, kind) => {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    const repo = `ghcr.io/agora-build/${component}`;
    const ref = kind.startsWith("id-") ? IMAGE_OLD : kind === "digest" ? `${repo}@${MANIFEST_OLD}` : `${repo}:previous-build`;
    const aliases = [kind === "id-tag" ? `${repo}:previous-build` : `${repo}@${MANIFEST_OLD}`];
    const r = upgrade({}, { runner, containers: [legacy("verified", runner, { name: component, ref, aliases })] });
    expect(r.status).toBe(0);
    expect(r.argvCalls.filter((args) => args[0] === "stop" || args[0] === "rm")).toEqual([["stop", "verified"], ["rm", "verified"]]);
  });

  it.each([{ PS_FAIL: "1" }, { DISCOVERY_INSPECT_FAIL: "1" }, { INSPECT_FAIL: "1" }, { ALIAS_INSPECT_FAIL: "1" }])("discovery failures never mean no existing container (%j)", (failure) => {
    const r = upgrade(failure, { containers: [legacy("old", false, { ref: IMAGE_OLD })], args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
  });
});

describe("token-selected services", () => {
  it.each([
    { contents: "EVAL_TOKEN=evtest\n", components: ["vox-eval-agentd"] },
    { contents: "EVAL_TOKEN=evtest\nCLASH_TOKEN=\n", components: ["vox-eval-agentd"] },
    { contents: "CLASH_TOKEN=crtest\n", components: ["vox-clash-runner"] },
    { contents: "CLASH_TOKEN=crtest\nEVAL_TOKEN=\n", components: ["vox-clash-runner"] },
    { contents: "EVAL_TOKEN=evtest\nCLASH_TOKEN=crtest\n", components: ["vox-clash-runner", "vox-eval-agentd"] },
    { contents: "", components: [] },
    { contents: "EVAL_TOKEN=\nCLASH_TOKEN=\n", components: [] },
    { contents: "AGENT_TOKEN=legacy-eval\nRUNNER_TOKEN=legacy-clash\n", components: [] },
  ])("only manages services selected by nonempty new token inputs (%j)", ({ contents, components }) => {
    const envFile = path.join(dir, "selected-services.env");
    fs.writeFileSync(envFile, contents);
    const r = upgrade({}, { defaultEnv: true, args: ["--env", envFile, "--force"], containers: [
      { id: "eval", name: "vox-eval-agentd", ref: "ghcr.io/agora-build/vox-eval-agentd:old", env: ["AGENT_TOKEN=evtest"] },
      { id: "clash", name: "vox-clash-runner", ref: "ghcr.io/agora-build/vox-clash-runner:old", env: ["RUNNER_TOKEN=crtest"] },
    ] });
    expect(r.status).toBe(0);
    expect(r.argvCalls.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--name") + 1]).sort()).toEqual(components);
    expect(r.argvCalls.filter((args) => args[0] === "pull").map((args) => args[1]).sort()).toEqual(components.map((component) => `ghcr.io/agora-build/${component}:latest`));
    expect(r.argvCalls.filter((args) => args[0] === "stop" || args[0] === "rm").every((args) => components.includes(args[1] === "eval" ? "vox-eval-agentd" : "vox-clash-runner"))).toBe(true);
    if (components.length === 0) {
      expect(r.calls).toEqual([]);
      expect(r.out).toContain("Sample .env");
    }
    expect(r.tempEntries).toEqual([]);
  });
});

describe("private Docker credential files", () => {
  it.each(["plain", "exported", "allexport", "inherited"])("keeps %s tokens out of child environments while retaining per-service env files", (mode) => {
    const tokenValues = {
      EVAL_TOKEN: "private-eval-token", CLASH_TOKEN: "private-clash-token",
      AGENT_TOKEN: "private-legacy-agent-token", RUNNER_TOKEN: "private-legacy-runner-token",
    };
    const envFile = path.join(dir, `token-export-${mode}.env`);
    const assignments = Object.entries(tokenValues).map(([key, value]) => `${mode === "exported" ? "export " : ""}${key}=${shellValue(value)}`).join("\n");
    fs.writeFileSync(envFile, mode === "inherited" ? "VOX_SERVER=http://localhost:5000\n" : `${mode === "allexport" ? "set -a\n" : ""}${assignments}\n`);
    const r = upgrade({ RUNNING_ID: "abc", ...(mode === "inherited" ? { ...tokenValues, SHELLOPTS: "allexport" } : {}) }, {
      both: true, defaultEnv: true, args: ["--env", envFile], inspectEnvs: true,
    });
    expect(r.status).toBe(0);
    expect(new Set(r.childEnvs.map((entry) => entry.command))).toEqual(new Set(["bash", "docker", "curl", "ip", "ps", "mktemp"]));
    for (const child of r.childEnvs) {
      expect(child.environment.filter((entry) => /^(EVAL_TOKEN|CLASH_TOKEN|AGENT_TOKEN|RUNNER_TOKEN)=/.test(entry)), child.command).toEqual([]);
      expect(child.environment.some((entry) => Object.values(tokenValues).some((token) => entry.includes(token))), child.command).toBe(false);
    }
    expect(r.tokenFiles.map((file) => file.content).sort()).toEqual([
      "AGENT_TOKEN=private-eval-token\n", "RUNNER_TOKEN=private-clash-token\n",
    ]);
    expect(r.tempEntries).toEqual([]);
  });

  it.each([false, true])("keeps token values out of argv with mode 0600 even under umask 000 (runner: %s)", (runner) => {
    const tokenName = runner ? "CLASH_TOKEN" : "EVAL_TOKEN";
    const runtimeName = runner ? "RUNNER_TOKEN" : "AGENT_TOKEN";
    const token = "  private * [xy] ' \" $literal --privileged \\ trailing  ";
    const envFile = path.join(dir, `private-token-${runner}.env`);
    fs.writeFileSync(envFile, `${tokenName}=${shellValue(token)}\n`);
    const r = upgrade({ RUNNING_ID: "abc", TMPDIR: path.join(dir, `private temp ${runner}`) }, { runner, defaultEnv: true, args: ["--env", envFile], permissiveUmask: true });
    expect(r.status).toBe(0);
    expect(r.tokenFiles).toHaveLength(1);
    expect(r.tokenFiles[0].content).toBe(`${runtimeName}=${token}\n`);
    expect(r.tokenFiles[0].mode).toBe("600");
    expect(r.tokenFiles[0].directoryMode).toBe("700");
    expect(r.argvCalls.find((args) => args[0] === "run")).toContain("--env-file");
    expect(r.argvCalls.flat().some((arg) => arg.includes(token) || /^(EVAL_TOKEN|CLASH_TOKEN|AGENT_TOKEN|RUNNER_TOKEN)=/.test(arg))).toBe(false);
    expect(r.calls.join("\n")).not.toContain(token);
    expect(r.out).not.toContain(token);
    expect(fs.existsSync(r.tokenFiles[0].path)).toBe(false);
    expect(r.tempEntries).toEqual([]);
  });

  it("gives each component only its own token and cleans both files", () => {
    const r = upgrade({ RUNNING_ID: "abc" }, { both: true });
    expect(r.status).toBe(0);
    expect(r.tokenFiles.map((file) => file.content).sort()).toEqual(["AGENT_TOKEN=evtest\n", "RUNNER_TOKEN=crtest\n"]);
    expect(new Set(r.tokenFiles.map((file) => file.path)).size).toBe(2);
    expect(r.argvCalls.flat().some((arg) => /^(EVAL_TOKEN|CLASH_TOKEN|AGENT_TOKEN|RUNNER_TOKEN)=/.test(arg))).toBe(false);
    expect(r.tempEntries).toEqual([]);
  });

  it.each([{ RUN_FAIL: "1" }, { RUN_SIGNAL: "TERM" }, { RUN_SIGNAL: "INT" }])("cleans credential files after Docker failure or interruption (%j)", (failure) => {
    const r = upgrade({ RUNNING_ID: "abc", ...failure }, { both: true });
    expect(r.status).not.toBe(0);
    expect(r.tokenFiles).toHaveLength("RUN_FAIL" in failure ? 2 : 1);
    expect(r.tokenFiles.every((file) => !fs.existsSync(file.path))).toBe(true);
    expect(r.tempEntries).toEqual([]);
  });

  it("cleans credential files when both replacements are skipped", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW }, { both: true });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.tokenFiles).toEqual([]);
    expect(r.tempEntries).toEqual([]);
  });

  it("a temp-directory failure never stops an existing container", () => {
    const r = upgrade({ RUNNING_ID: "abc", ENV_TEMP_FAIL: "1" }, { both: true, args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("cannot create private container env directory");
    expect(r.tempEntries).toEqual([]);
  });

  it("a credential-file write failure never stops an existing container", () => {
    const bashEnv = path.join(dir, "fail-token-write.sh");
    fs.writeFileSync(bashEnv, 'printf() { case "${2:-}" in AGENT_TOKEN=*|RUNNER_TOKEN=*) return 1 ;; *) builtin printf "$@" ;; esac; }\n');
    const r = upgrade({ RUNNING_ID: "abc", BASH_ENV: bashEnv }, { both: true, args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("cannot write private container env file");
    expect(r.tempEntries).toEqual([]);
  });

  it.each([false, true].flatMap((runner) => ["\n", "\r"].map((separator) => [runner, separator] as const)))("rejects line breaks in credentials before any Docker call (runner: %s, separator: %j)", (runner, separator) => {
    const tokenName = runner ? "CLASH_TOKEN" : "EVAL_TOKEN";
    const envFile = path.join(dir, `multiline-token-${runner}.env`);
    fs.writeFileSync(envFile, `${tokenName}=${shellValue(`token${separator}INJECTED=value`)}\n`);
    const r = upgrade({ RUNNING_ID: "abc" }, { runner, defaultEnv: true, args: ["--env", envFile, "--force"] });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(`${tokenName} must not contain line breaks`);
    expect(r.out).not.toContain("INJECTED");
    expect(r.tempEntries).toEqual([]);
  });
});

describe("Docker argument boundaries and runtime preflight", () => {

  it.each([false, true])("preserves whitespace, globs, quotes, newlines and option-like text as literal env values (runner: %s)", (runner) => {
    const tokenName = runner ? "CLASH_TOKEN" : "EVAL_TOKEN";
    const values = {
      [tokenName]: "token with spaces\t* [xy] ' \" --privileged",
      VOX_SERVER: "https://vox.example.test/path with space?x=* &y=[abc] --privileged",
      VOX_AGENT_NAME: "* [xy] ' \" --privileged --mount=type=bind,src=/,dst=/host\nnext-line",
      LOCAL_DEBUG: "debug * --privileged", HEADLESS: "false --network host",
    };
    const envFile = path.join(dir, `literal-${runner}.env`);
    fs.writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${shellValue(value)}`).join("\n"));
    fs.writeFileSync(path.join(dir, "VOX_AGENT_NAME=glob-expanded"), "");
    const r = upgrade({ RUNNING_ID: "abc" }, { runner, defaultEnv: true, args: ["--env", envFile, "--force"] });
    expect(r.status).toBe(0);
    const run = r.argvCalls.find((args) => args[0] === "run")!;
    const envValues = run.filter((_, index) => run[index - 1] === "-e");
    for (const [key, value] of Object.entries(values)) {
      if (key === tokenName) expect(r.tokenFiles[0].content).toBe(`${runner ? "RUNNER_TOKEN" : "AGENT_TOKEN"}=${value}\n`);
      else expect(envValues).toContain(`${key}=${value}`);
    }
    expect(envValues).toHaveLength(Object.keys(values).length);
    expect(run.join("\n")).not.toContain(values[tokenName]);
    expect(run).not.toContain("--privileged");
    expect(run).not.toContain("--network");
    expect(run.some((arg) => arg.startsWith("--mount="))).toBe(false);
    expect(run.at(-1)).toBe(runner ? RUNNER_REF : AGENT_REF);
  });

  it("keeps DialF socket/exchange paths containing spaces and glob characters in single arguments", async () => {
    const specialSock = path.join(dir, "phone * [a] ' socket");
    const specialExchange = path.join(dir, "exchange * [a] ' --privileged");
    const specialServer = net.createServer().listen(specialSock);
    await new Promise((resolve) => specialServer.once("listening", resolve));
    try {
      const r = upgrade({ RUNNING_ID: "abc", DIALF_SOCKET: specialSock, DIALF_EXCHANGE_DIR: specialExchange });
      expect(r.status).toBe(0);
      const run = r.argvCalls.find((args) => args[0] === "run")!;
      const mounts = run.filter((_, index) => run[index - 1] === "-v");
      expect(mounts).toContain(`${specialSock}:${specialSock}`);
      expect(mounts).toContain(`${specialExchange}:${specialExchange}`);
      expect(run).toContain(`VOX_DIALF_SOCKET=${specialSock}`);
      expect(run).toContain(`VOX_DIALF_EXCHANGE_DIR=${specialExchange}`);
      expect(run).not.toContain("--privileged");
    } finally { specialServer.close(); }
  });

  it("resets argument arrays between agent and runner", () => {
    const r = upgrade({ RUNNING_ID: "abc", DIALF_SOCKET: sock, VOX_LINK_TYPE: "wifi" }, { both: true });
    expect(r.status).toBe(0);
    const runs = r.argvCalls.filter((args) => args[0] === "run");
    const agent = runs.find((args) => args.at(-1) === AGENT_REF)!;
    const runner = runs.find((args) => args.at(-1) === RUNNER_REF)!;
    expect(r.tokenFiles.find((file) => file.path.endsWith("vox-eval-agentd.env"))?.content).toBe("AGENT_TOKEN=evtest\n");
    expect(agent).toContain("-v");
    expect(r.tokenFiles.find((file) => file.path.endsWith("vox-clash-runner.env"))?.content).toBe("RUNNER_TOKEN=crtest\n");
    expect(runner).not.toContain("-v");
    expect(runner.some((arg) => /^(EVAL_TOKEN|AGENT_TOKEN|VOX_DIALF_|VOX_LINK_TYPE)=/.test(arg))).toBe(false);
  });

  it.each(["no", "always", "unless-stopped", "on-failure", "on-failure:0", "on-failure:3", "on-failure:0003", "on-failure:9223372036854775807"])("validates and forwards restart policy %s", (policy) => {
    const r = upgrade({ RUNNING_ID: "abc", RESTART_POLICY: policy });
    expect(r.status).toBe(0);
    const run = r.argvCalls.find((args) => args[0] === "run")!;
    expect(run[run.indexOf("--restart") + 1]).toBe(policy === "on-failure:0003" ? "on-failure:3" : policy);
  });

  it.each([
    "never", "always:3", "unless-stopped:3", "no:1", "on-failure:", "on-failure:-1",
    "on-failure:1.5", "on-failure:abc", "always --privileged", "on-failure:9223372036854775808",
    `on-failure:${"9".repeat(100)}`,
  ])("invalid restart policy %s fails before any Docker call, including with --force", (policy) => {
    const r = upgrade({ RUNNING_ID: "abc", RESTART_POLICY: policy }, { args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("RESTART_POLICY");
    expect(r.out).toContain("No containers were changed");
  });

  it("validates the policy loaded from the env file, not only the inherited environment", () => {
    const envFile = path.join(dir, "invalid-restart.env");
    fs.writeFileSync(envFile, "EVAL_TOKEN=evtest\nRESTART_POLICY=invalid\n");
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, RESTART_POLICY: "always" }, { defaultEnv: true, args: ["--env", envFile] });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
});

describe("maintenance opt-out", () => {
  it.each([false, true])("VOX_INSTANCE_DISABLED=true in the env file prevents every Docker operation (force: %s)", (force) => {
    const envFile = path.join(dir, "disabled.env");
    fs.writeFileSync(envFile, "EVAL_TOKEN=evtest\nCLASH_TOKEN=crtest\nVOX_INSTANCE_DISABLED=true\nRESTART_POLICY=invalid\n");
    const r = upgrade({ RUNNING_ID: "abc", DOCKER_STATES: "exited" }, { both: true, defaultEnv: true, args: ["--env", envFile, ...(force ? ["--force"] : [])] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("skipping all container operations, including --force");
  });

  it.each(["false", "0"])("VOX_INSTANCE_DISABLED=%s leaves recovery enabled", (disabled) => {
    const r = upgrade({ RUNNING_ID: "abc", DOCKER_STATES: "exited", VOX_INSTANCE_DISABLED: disabled });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
  });

  it.each(["yes", "TRUE", "disabled"])("invalid maintenance value %s fails closed without Docker calls", (disabled) => {
    const r = upgrade({ VOX_INSTANCE_DISABLED: disabled });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("VOX_INSTANCE_DISABLED must be");
  });
});

describe("per-service failures do not skip the other configured service", () => {
  it("continues after a failed stale DialF restart", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, DIALF_SOCKET: sock,
      PREV_SOCK: sock, CONT_INO: "1", RESTART_FAIL: "1", RUNNER_TARGET_IMAGE: IMAGE_OLD }, { both: true });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Error: could not restart vox-eval-agentd");
    expect(r.out).toContain("Started vox-clash-runner");
    expect(r.out).toContain("Finished with errors");
    expect(r.argvCalls).not.toContainEqual(["stop", "abc"]);
    expect(r.tempEntries).toEqual([]);
  });

  it("continues after a failed restart-policy update", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW,
      CURRENT_RESTART_POLICY: "no", UPDATE_FAIL: "1" }, { both: true });
    expect(r.status).toBe(1);
    expect(r.argvCalls.filter((args) => args[0] === "update")).toHaveLength(2);
    expect(r.out).toContain("Error: could not update restart policy for vox-eval-agentd");
    expect(r.out).toContain("Error: could not update restart policy for vox-clash-runner");
    expect(r.out).toContain("Finished with errors");
    expect(r.actions).toEqual([]);
    expect(r.tempEntries).toEqual([]);
  });

  it("leaves the old agent untouched and continues when DialF exchange preparation fails", () => {
    const blockedExchange = path.join(dir, "blocked-exchange");
    fs.writeFileSync(blockedExchange, "not a directory");
    const r = upgrade({ RUNNING_ID: "abc", DIALF_SOCKET: sock,
      DIALF_EXCHANGE_DIR: blockedExchange }, { both: true });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Error: cannot prepare DialF exchange directories; leaving vox-eval-agentd unchanged");
    expect(r.out).toContain("Started vox-clash-runner");
    expect(r.out).toContain("Finished with errors");
    expect(r.argvCalls).not.toContainEqual(["stop", "abc"]);
    expect(r.argvCalls).not.toContainEqual(["rm", "abc"]);
    expect(r.tempEntries).toEqual([]);
  });
});

describe("container replacement preserves manual recovery", () => {
  it.each([false, true])("removes the old container only after the replacement is running (runner: %s)", (runner) => {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    const r = upgrade({ RUNNING_ID: "abc" }, { runner });
    expect(r.status).toBe(0);
    const rename = r.argvCalls.findIndex((args) => args[0] === "rename");
    const run = r.argvCalls.findIndex((args) => args[0] === "run");
    const verify = r.argvCalls.findIndex((args) => args[0] === "inspect" && args.at(-1) === CONTAINER_NEW);
    const remove = r.argvCalls.findIndex((args) => args[0] === "rm");
    expect(r.argvCalls[rename]).toEqual(["rename", "abc", expect.stringMatching(new RegExp(`^${component}-previous-vox-manager-env\\.`))]);
    expect(rename).toBeLessThan(run);
    expect(run).toBeLessThan(verify);
    expect(verify).toBeLessThan(remove);
    expect(r.argvCalls[remove]).toEqual(["rm", "abc"]);
    expect(r.out).not.toContain("docker start abc");
    expect(r.tempEntries).toEqual([]);
  });

  it.each([false, true])("a failed run preserves and renames back the old container (runner: %s)", (runner) => {
    const component = runner ? "vox-clash-runner" : "vox-eval-agentd";
    const r = upgrade({ RUNNING_ID: "abc", RUN_FAIL: "1" }, { runner });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual(["stop", "run"]);
    expect(r.argvCalls.filter((args) => args[0] === "rename").at(-1)).toEqual(["rename", "abc", component]);
    expect(r.argvCalls.some((args) => args[0] === "start")).toBe(false);
    expect(r.out).toContain(`Old container preserved: abc (image ${IMAGE_OLD})`);
    expect(r.out).toContain("docker start abc");
    expect(r.out).toContain("Finished with errors");
    expect(r.tempEntries).toEqual([]);
  });

  it.each([false, true])("a partially created replacement is removed only by its own ID (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc", RUN_PARTIAL_FAIL: "1" }, { runner });
    expect(r.status).toBe(1);
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", CONTAINER_NEW]]);
    expect(r.out).toContain("docker start abc");
    expect(r.tempEntries).toEqual([]);
  });

  it.each(["created", "exited", "restarting", "dead", "paused"])("does not delete the old container if the new state is %s", (newState) => {
    const r = upgrade({ RUNNING_ID: "abc", NEW_STATE: newState });
    expect(r.status).toBe(1);
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", CONTAINER_NEW]]);
    expect(r.out).toContain("docker start abc");
  });

  it("a failed new-state inspection preserves the old container", () => {
    const r = upgrade({ RUNNING_ID: "abc", NEW_STATE_INSPECT_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", CONTAINER_NEW]]);
    expect(r.out).toContain("docker start abc");
  });

  it.each([
    { CID_FILE_MISSING: "1" }, { CID_FILE_CONTENT: "vox-eval-agentd" },
    { CID_FILE_CONTENT: "--force" }, { CID_FILE_CONTENT: "a".repeat(65) },
  ])("an absent/invalid cidfile never permits name-based deletion (%j)", (failure) => {
    const r = upgrade({ RUNNING_ID: "abc", ...failure });
    expect(r.status).toBe(1);
    expect(r.argvCalls.some((args) => args[0] === "rm")).toBe(false);
    expect(r.out).toContain("docker start abc");
    expect(r.tempEntries).toEqual([]);
  });

  it("continues with the second service after the first fails, and exits nonzero", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUN_FAIL_AT: "1" }, { both: true });
    expect(r.status).toBe(1);
    const runs = r.argvCalls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(2);
    const failedComponent = runs[0][runs[0].indexOf("--name") + 1];
    const failedId = failedComponent === "vox-eval-agentd" ? "abc" : "runner-abc";
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", failedId === "abc" ? "runner-abc" : "abc"]]);
    expect(r.out).toContain(`docker start ${failedId}`);
    expect(r.out).toContain(`Started ${failedComponent === "vox-eval-agentd" ? "vox-clash-runner" : "vox-eval-agentd"}`);
    expect(r.tempEntries).toEqual([]);
  });

  it("a failed fresh install also continues with the second service", () => {
    const r = upgrade({ RUN_FAIL_AT: "1" }, { both: true, args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual(["run", "run"]);
    expect(r.out).not.toContain("Old container preserved");
    expect(r.out).not.toContain("docker start ");
    expect(r.tempEntries).toEqual([]);
  });

  it("preserves a legacy container's original name on failure", () => {
    const r = upgrade({ RUN_FAIL: "1" }, { containers: [{
      id: "legacy-id", name: "my_original_agent", ref: "ghcr.io/agora-build/vox-eval-agentd:old",
      env: ["AGENT_TOKEN=evtest"],
    }] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual(["stop", "run"]);
    expect(r.argvCalls.some((args) => args[0] === "rename")).toBe(false);
    expect(r.out).toContain("docker start legacy-id");
  });

  it.each([
    { RUNNING_IMAGE: IMAGE_NEW, DIALF_SOCKET: "socket" },
    { RUNNING_IMAGE: IMAGE_NEW, DOCKER_STATES: "exited" },
  ])("same-image recreation retains the old container when startup fails (%j)", (options) => {
    const r = upgrade({ RUNNING_ID: "abc", RUN_FAIL: "1", ...options, ...(options.DIALF_SOCKET ? { DIALF_SOCKET: sock } : {}) });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual(["stop", "run"]);
    expect(r.out).toContain("docker start abc");
  });

  it.each(["TERM", "INT"])("interruption by %s preserves the old container and cleans the candidate", (signal) => {
    const r = upgrade({ RUNNING_ID: "abc", RUN_SIGNAL: signal });
    expect(r.status).toBe(signal === "TERM" ? 143 : 130);
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", CONTAINER_NEW]]);
    expect(r.argvCalls.filter((args) => args[0] === "rename").at(-1)).toEqual(["rename", "abc", "vox-eval-agentd"]);
    expect(r.out).toContain("docker start abc");
    expect(r.tempEntries).toEqual([]);
  });

  it.each([
    [{ ORIGINAL_NAME_FAIL: "1" }, []],
    [{ STOP_FAIL: "1" }, ["stop"]],
    [{ RENAME_FAIL_AT: "1" }, ["stop"]],
  ] as const)("stop/name failures never launch or delete a container (%j)", (failure, actions) => {
    const r = upgrade({ RUNNING_ID: "abc", ...failure });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual(actions);
    expect(r.tempEntries).toEqual([]);
  });

  it("failure to restore a name still prints ID-based recovery", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUN_FAIL: "1", RENAME_FAIL_AT: "2" });
    expect(r.status).toBe(1);
    expect(r.argvCalls.some((args) => args[0] === "rm")).toBe(false);
    expect(r.out).toContain("could not restore the old container's name");
    expect(r.out).toContain("docker start abc");
  });

  it("failure to remove the old container does not stop the working replacement", () => {
    const r = upgrade({ RUNNING_ID: "abc", OLD_RM_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.argvCalls.filter((args) => args[0] === "rm")).toEqual([["rm", "abc"]]);
    expect(r.out).toContain("replacement is running, but old container abc could not be removed");
    expect(r.out).toContain("Started vox-eval-agentd");
    expect(r.out).not.toContain("docker start abc");
  });
});

describe("command-line state cannot be overridden by env files", () => {
  it.each([
    ["manager_force=1", []],
    ["manager_force=", ["--force"]],
    ["manager_env_file=another.env", []],
    ["ENV_FILE=another.env", []],
    ["WAIT_TIMEOUT=0", []],
    ["POLL_INTERVAL=0", []],
  ] as const)("rejects reserved assignment %s before Docker (args: %j)", (assignment, args) => {
    const envFile = path.join(dir, "reserved-setting.env");
    fs.writeFileSync(envFile, `EVAL_TOKEN=secret-not-for-output\n${assignment}\n`);
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "occupied" }, { defaultEnv: true, args: ["--env", envFile, ...args] });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("without overriding reserved CLI settings");
    expect(r.out).toContain("Sample .env");
    expect(r.out).not.toContain("secret-not-for-output");
  });
});

describe("health checks fail closed before interrupting work", () => {
  it.each([false, true])("requires an explicit idle response (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { runner });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain("Status: idle after 0s");
  });

  it.each(["occupied", "uploading", "timeout", "http-error"])("retries %s and stops only after explicit idle", (status) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: `${status}\nidle` });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
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
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain("container is unknown after 300s");
  });
});

describe("unattended upgrades and Docker-native recovery", () => {
  it.each(["timeout", "occupied", "uploading"])("--force skips %s health waits and prompts", (health) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: health }, { command: true, args: ["--force"] });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.calls.some((call) => /^(curl |sleep 10$)/.test(call))).toBe(false);
    expect(r.out).toContain("--force bypasses idle checks");
    expect(r.out).toContain("active evaluations may be interrupted");
    expect(r.out).not.toContain("Timeout:");
  });

  it("--force works as the first option with --env and an env-pinned version on a fresh install", () => {
    const envFile = path.join(dir, "forced-version.env");
    fs.writeFileSync(envFile, "EVAL_TOKEN=evtest\nEVAL_VERSION=7c3b1a2\n");
    const r = upgrade({}, { defaultEnv: true, args: ["--force", "--env", envFile] });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["run"]);
    expect(r.out).toContain("--force confirms starting a new container");
    expect(r.calls.find((call) => call.startsWith("docker run"))).toContain("--label org.agora.vox.version=7c3b1a2");
  });

  it("--force handles both configured components without input", () => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "timeout" }, { both: true, args: ["--force"] });
    expect(r.status).toBe(0);
    expect(r.calls.filter((call) => call.startsWith("docker run"))).toHaveLength(2);
    expect(r.calls.some((call) => /^(curl |sleep 10$)/.test(call))).toBe(false);
  });

  it("--force explicitly accepts loss of a previous DialF mount", () => {
    const r = upgrade({ RUNNING_ID: "abc", PREV_SOCK: "/missing/dialfd.sock", HEALTH_STEPS: "timeout" }, { args: ["--force"] });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain("--force confirms replacement without DialF support");
  });

  it.each([
    { PULL_FAIL_IMAGE: "vox-eval-agentd" },
    { DIGEST_INSPECT_FAIL: "1" },
    { PINNED_IMAGE_ID: IMAGE_OLD },
  ])("--force cannot bypass image preflight failure %j", (failure) => {
    const r = upgrade({ RUNNING_ID: "abc", ...failure }, { args: ["--force"] });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
  });

  it.each([false, true])("same-image inactive recovery retains DialF-loss consent (force: %s)", (force) => {
    const r = upgrade({
      EXISTING_ID: "abc", DOCKER_STATES: "exited", RUNNING_IMAGE: IMAGE_NEW,
      PREV_SOCK: "/missing/dialfd.sock",
    }, { args: force ? ["--force"] : [] });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(force ? ["stop", "run", "rm"] : []);
    expect(r.out).toContain("a new container WON'T take phone jobs");
    if (force) expect(r.out).toContain("--force confirms replacement without DialF support");
    else expect(r.out).toContain("Leaving the running vox-eval-agentd as it is");
  });

  it.each(["created", "exited", "dead", "restarting"].flatMap((state) => [
    [state, false], [state, true],
  ] as const))("Docker state %s bypasses unknown health after a 10-second recheck (runner: %s)", (state, runner) => {
    const r = upgrade({ EXISTING_ID: "abc", DOCKER_STATES: state, HEALTH_STEPS: "timeout" }, { runner });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.calls).toContain("docker ps -aq --no-trunc");
    expect(r.calls.some((call) => call.startsWith("curl "))).toBe(false);
    expect(r.calls.filter((call) => call === "sleep 10")).toHaveLength(1);
    expect(r.out).toContain(`Docker state: ${state}`);
    expect(r.out).toContain("after recheck — proceeding without a health wait");
    expect(r.out).not.toContain("Timeout:");
  });

  it.each(["created", "exited", "dead", "restarting"])("recovers a %s container even when the selected image has not changed", (state) => {
    const r = upgrade({ EXISTING_ID: "abc", DOCKER_STATES: state, RUNNING_IMAGE: IMAGE_NEW });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.out).toContain(`Docker state is ${state}; recreating container`);
    expect(r.out).not.toContain("Skipping replacement");
  });

  it("rechecks Docker state during the health wait and confirms a crash after 10 seconds", () => {
    const r = upgrade({ RUNNING_ID: "abc", DOCKER_STATES: "running\nrunning\nexited", HEALTH_STEPS: "timeout" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.calls.filter((call) => call.startsWith("curl "))).toHaveLength(1);
    expect(r.calls.filter((call) => call === "sleep 10")).toHaveLength(2);
    expect(r.out).toContain("Docker state: exited");
    expect(r.out).not.toContain("Timeout:");
  });

  it.each(["created", "exited", "dead", "restarting"])("a %s container that becomes running after 10 seconds must pass health checks", (state) => {
    const r = upgrade({ EXISTING_ID: "abc", DOCKER_STATES: `${state}\n${state}\nrunning`, HEALTH_STEPS: "occupied\nidle" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
    expect(r.calls.filter((call) => call === "sleep 10")).toHaveLength(2);
    expect(r.calls.filter((call) => call.startsWith("curl "))).toHaveLength(2);
    expect(r.out).toContain("Docker state after recheck: running — checking health");
    expect(r.out).toContain("Status: idle after 20s");
    expect(r.out).not.toContain("proceeding without a health wait");
  });

  it.each([
    { DOCKER_STATES: "restarting\nrestarting\nrunning" },
    { DOCKER_STATES: "exited\nexited\nunknown" },
  ])("state recovery or an inconclusive recheck %j never bypasses unknown health", (state) => {
    const r = upgrade({ EXISTING_ID: "abc", HEALTH_STEPS: "timeout", ...state });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("stopping may interrupt active work");
    expect(r.out).not.toContain("proceeding without a health wait");
  });

  it.each([
    { DOCKER_STATES: "running" }, { DOCKER_STATES: "paused" },
    { DOCKER_STATES: "unknown" }, { STATE_INSPECT_FAIL: "1" },
  ])("state %j never treats unreachable health as inactive without --force", (state) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_STEPS: "timeout", ...state });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("stopping may interrupt active work");
    expect(r.out).toContain("Skipping vox-eval-agentd");
  });

  it("a new install without --force still declines safely on EOF", () => {
    const r = upgrade({});
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("Skipping vox-eval-agentd");
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
    fs.writeFileSync(envFile, "EVAL_TOKEN=evtest\nCLASH_TOKEN=crtest\nHEALTH_PORT=8123\n");
    const r = upgrade({ RUNNING_ID: "abc" }, { both: true, defaultEnv: true, args: ["--env", envFile] });
    expect(r.status).toBe(0);
    const runs = r.calls.filter((call) => call.startsWith("docker run"));
    expect(runs).toHaveLength(2);
    expect(runs.every((call) => call.includes("-p 127.0.0.1::8123 "))).toBe(true);
    expect(runs.every((call) => call.includes("-e HEALTH_PORT=8123 "))).toBe(true);
    expect(r.calls.filter((call) => call.startsWith("docker port "))).toEqual(expect.arrayContaining([
      "docker port abc 8099/tcp", "docker port runner-abc 8099/tcp",
    ]));
  });

  it.each(["0", "65536", "abc", "8099:8099", "-1"])("invalid internal health port %s fails before touching Docker", (port) => {
    const r = upgrade({ RUNNING_ID: "abc", HEALTH_PORT: port });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("HEALTH_PORT must be an integer");
  });
});

describe("install/upgrade command dispatch", () => {
  it.each([false, true])("prints manager self-update and manual download/save commands before container upgrades (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { runner });
    expect(r.status).toBe(0);
    expect(r.out).toContain("  ./vox-manager.sh self");
    expect(r.out).toContain("Manual download (saves vox-manager.sh in the current directory):");
    expect(r.out).toContain("curl -fsSL --proto '=https' --proto-redir '=https'");
    expect(r.out).toContain("-o vox-manager.sh");
    expect(r.out).toContain("https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh");
    expect(r.out).toContain("chmod +x vox-manager.sh");
    expect(r.out.indexOf("Manual download")).toBeLessThan(r.out.indexOf("Pulling selected image:"));
  });

  it("no arguments still use .env and match an explicit vox_agent command", () => {
    fs.copyFileSync(path.join(dir, "agent.env"), path.join(dir, ".env"));
    const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW };
    const implicit = upgrade(env, { defaultEnv: true });
    const explicit = upgrade(env, { command: true, defaultEnv: true });
    expect(implicit.status).toBe(0);
    expect(explicit.status).toBe(0);
    expect(implicit.comparableCalls).toEqual(explicit.comparableCalls);
  });

  it("no arguments install latest on a new host using .env in the current directory", () => {
    fs.copyFileSync(path.join(dir, "agent.env"), path.join(dir, ".env"));
    const r = upgrade({}, { defaultEnv: true, answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["run"]);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:latest");
    const run = r.calls.find((call) => call.startsWith("docker run"));
    expect(r.tokenFiles[0].content).toBe("AGENT_TOKEN=evtest\n");
    expect(run).toContain("VOX_SERVER=http://localhost:5000");
    expect(run?.endsWith(` ${AGENT_REF}`)).toBe(true);
  });

  it.each([false, true])("--env selects the specified file with spaces (implicit command: %s)", (implicit) => {
    const envFile = path.join(dir, "agent config.env");
    fs.copyFileSync(path.join(dir, "agent.env"), envFile);
    fs.writeFileSync(path.join(dir, ".env"), "CLASH_TOKEN=wrong-default\n");
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
    expect(r.actions).toEqual(["run"]);
    expect(r.out).toContain("Starting new container");
  });

  it("positional env-file invocations still match vox_agent for agents and runners", () => {
    for (const runner of [false, true]) {
      const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD, LATEST_IMAGE: IMAGE_NEW };
      expect(upgrade(env, { runner }).comparableCalls).toEqual(upgrade(env, { runner, command: true }).comparableCalls);
    }
  });
});

describe("selected Docker image versions and rollback", () => {
  it.each(["explicit", "equals", "positional"])("loads the version from the %s env-file argument", (form) => {
    const envFile = path.join(dir, "pinned-version.env");
    fs.writeFileSync(envFile, "EVAL_TOKEN=evtest\nEVAL_VERSION=c64ff76\n");
    const args = form === "explicit" ? ["--env", envFile] : form === "equals" ? [`--env=${envFile}`] : [envFile];
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
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_OLD }, { command: true, runner, versions: { eval: "7c3b1a2", clash: "7c3b1a2" } });
    const image = `ghcr.io/agora-build/${runner ? "vox-clash-runner" : "vox-eval-agentd"}:7c3b1a2`;
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker pull ${image}`);
    expect(r.calls).toContain(`docker image inspect ${image} --format={{.Id}}`);
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ${runner ? RUNNER_REF : AGENT_REF}`)).toBe(true);
    expect(r.calls.join("\n")).not.toContain(":latest");
    expect(r.out).toContain(`Verified ${image}`);
  });

  it("installs a specific version on a new host after confirmation", () => {
    const r = upgrade({}, { command: true, versions: { eval: "7c3b1a2", clash: "7c3b1a2" }, answers: "y\n" });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["run"]);
    expect(r.out).toContain("Starting new container");
    expect(r.out).toContain("vox-eval-agentd:7c3b1a2");
  });

  it("rolls back to an older image, preserving existing Docker configuration", () => {
    const env = { RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW, LATEST_IMAGE: IMAGE_OLD, DIALF_SOCKET: sock };
    const r = upgrade(env, { command: true, versions: { eval: "previous-build", clash: "previous-build" } });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual(["stop", "run", "rm"]);
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
    const r = upgrade({ RUNNING_ID: "abc" }, { command: true, versions: { eval: digest, clash: digest } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker pull ghcr.io/agora-build/vox-eval-agentd@${digest}`);
    expect(r.calls.find((call) => call.startsWith("docker run"))?.endsWith(` ghcr.io/agora-build/vox-eval-agentd@${digest}`)).toBe(true);
  });

  it("does not replace a container already running the selected version", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: IMAGE_NEW }, { command: true, versions: { eval: "7c3b1a2", clash: "7c3b1a2" } });
    expect(r.status).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("Already running the selected image (ghcr.io/agora-build/vox-eval-agentd:7c3b1a2)");
  });

  it("loads per-service versions from the current directory's .env with no arguments", () => {
    const env = { RUNNING_ID: "abc" };
    fs.writeFileSync(path.join(dir, ".env"), "EVAL_TOKEN=evtest\nCLASH_TOKEN=crtest\nEVAL_VERSION=eval-build\nCLASH_VERSION=clash-build\n");
    const implicit = upgrade(env, { defaultEnv: true, both: true });
    expect(implicit.status).toBe(0);
    expect(implicit.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:eval-build");
    expect(implicit.calls).toContain("docker pull ghcr.io/agora-build/vox-clash-runner:clash-build");
  });

  it.each([
    ["eval-build", "clash-build"],
    [MANIFEST_NEW, MANIFEST_OLD],
    [MANIFEST_NEW, "clash-build"],
    ["eval-build", MANIFEST_OLD],
  ])("keeps each service's selection, pinned reference and version label separate (eval: %s, clash: %s)", (evalVersion, clashVersion) => {
    const evalRepo = "ghcr.io/agora-build/vox-eval-agentd";
    const clashRepo = "ghcr.io/agora-build/vox-clash-runner";
    const r = upgrade({
      RUNNING_ID: "abc", RUNNER_TARGET_IMAGE: `sha256:${"e".repeat(64)}`,
      REPO_DIGESTS: `${evalRepo}@${MANIFEST_NEW}\n${clashRepo}@${MANIFEST_OLD}`,
    }, { both: true, versions: { eval: evalVersion, clash: clashVersion } });
    expect(r.status).toBe(0);
    const runs = r.argvCalls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(2);
    for (const [component, repo, version, digest] of [
      ["vox-eval-agentd", evalRepo, evalVersion, MANIFEST_NEW],
      ["vox-clash-runner", clashRepo, clashVersion, MANIFEST_OLD],
    ]) {
      const selectedRef = `${repo}${version.startsWith("sha256:") ? "@" : ":"}${version}`;
      expect(r.calls).toContain(`docker pull ${selectedRef}`);
      const run = runs.find((args) => args[args.indexOf("--name") + 1] === component);
      expect(run?.at(-1)).toBe(`${repo}@${digest}`);
      expect(run).toContain(`org.agora.vox.image=${selectedRef}`);
      expect(run).toContain(`org.agora.vox.version=${version}`);
    }
    const firstStop = r.argvCalls.findIndex((args) => args[0] === "stop");
    expect(r.argvCalls.every((args, index) => args[0] !== "image" || index < firstStop)).toBe(true);
  });

  it.each([false, true])("an omitted service version independently defaults to latest (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { both: true, versions: runner ? { eval: "eval-build" } : { clash: "clash-build" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`docker pull ghcr.io/agora-build/vox-eval-agentd:${runner ? "eval-build" : "latest"}`);
    expect(r.calls).toContain(`docker pull ghcr.io/agora-build/vox-clash-runner:${runner ? "latest" : "clash-build"}`);
  });

  it("empty versions default to latest for both services", () => {
    const r = upgrade({ RUNNING_ID: "abc" }, { both: true, versions: { eval: "", clash: "" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:latest");
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-clash-runner:latest");
  });

  it.each([false, true].flatMap((runner) => [
    "-latest", "repo/image:tag", "sha256:short", `sha256:${"A".repeat(64)}`,
    "a".repeat(129), "x y", "$(touch injected)", "secret-not-for-output\nlatest",
  ].map((version) => [runner, version] as const)))("rejects invalid configured versions before Docker (runner: %s, version: %j)", (runner, version) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { both: true, versions: runner ? { clash: version } : { eval: version } });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(`${runner ? "CLASH_VERSION" : "EVAL_VERSION"} must be a Docker image tag or sha256 manifest digest`);
    expect(r.out).toContain("EVAL_VERSION=latest");
    expect(r.out).toContain("CLASH_VERSION=latest");
    expect(r.out).not.toContain("secret-not-for-output");
    expect(fs.existsSync(path.join(dir, "injected"))).toBe(false);
  });

  it.each([false, true])("ignores versions for a service without a token (runner: %s)", (runner) => {
    const r = upgrade({ RUNNING_ID: "abc" }, { runner, versions: runner ? { eval: "invalid/version" } : { clash: "invalid/version" } });
    expect(r.status).toBe(0);
    expect(r.calls.filter((call) => call.startsWith("docker pull"))).toHaveLength(1);
  });

  it("a failed second digest pull leaves both old containers untouched", () => {
    const r = upgrade({ RUNNING_ID: "abc", PULL_FAIL_AT: "2" }, { both: true, versions: { eval: MANIFEST_NEW, clash: MANIFEST_OLD } });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.calls.filter((call) => call.startsWith("docker pull")).sort()).toEqual([
      `docker pull ghcr.io/agora-build/vox-clash-runner@${MANIFEST_OLD}`,
      `docker pull ghcr.io/agora-build/vox-eval-agentd@${MANIFEST_NEW}`,
    ]);
    expect(r.out).toContain("No containers were changed");
  });

  it("an unavailable version leaves the existing container untouched", () => {
    const r = upgrade({ RUNNING_ID: "abc", PULL_FAIL_IMAGE: "vox-eval-agentd" }, { command: true, versions: { eval: "missing-build", clash: "missing-build" } });
    expect(r.status).toBe(1);
    expect(r.actions).toEqual([]);
    expect(r.out).toContain("No containers were changed");
    expect(r.calls.some((call) => call.startsWith("docker image inspect"))).toBe(false);
  });

  it("a failed image inspection leaves the existing container untouched", () => {
    const r = upgrade({ RUNNING_ID: "abc", TARGET_INSPECT_FAIL: "1" }, { command: true, versions: { eval: "7c3b1a2", clash: "7c3b1a2" } });
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
    const r = upgrade({ RUNNING_ID: "abc" }, { command: true, both: true, versions: { eval: "7c3b1a2", clash: "7c3b1a2" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-eval-agentd:7c3b1a2");
    expect(r.calls).toContain("docker pull ghcr.io/agora-build/vox-clash-runner:7c3b1a2");
    const firstStop = r.calls.findIndex((call) => call.startsWith("docker stop"));
    const inspections = r.calls.flatMap((call, index) => call.startsWith("docker image inspect") ? [index] : []);
    expect(inspections).toHaveLength(6);
    expect(inspections.every((index) => index < firstStop)).toBe(true);
  });

  it("keeps agent and runner image IDs separate when both use the same tag", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNER_TARGET_IMAGE: IMAGE_OLD }, { command: true, both: true, versions: { eval: "7c3b1a2", clash: "7c3b1a2" } });
    expect(r.status).toBe(0);
    const runs = r.calls.filter((call) => call.startsWith("docker run"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--name vox-eval-agentd");
    expect(runs[0].endsWith(` ${AGENT_REF}`)).toBe(true);
    expect(r.out).toContain("Already running the selected image (ghcr.io/agora-build/vox-clash-runner:7c3b1a2)");
  });

  it("a missing second image cannot leave a multi-container rollback half-applied", () => {
    const r = upgrade({ RUNNING_ID: "abc", PULL_FAIL_AT: "2" }, { command: true, both: true, versions: { eval: "missing-build", clash: "missing-build" } });
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
    expect(r.actions).toEqual(["stop", "run", "rm"]);
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
