import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { dialfConnectFailure, probeDialf } from "../vox_eval_agentd/dialf-client";

// scripts/vox-upgrade.sh and DialF (Phone vs Agent). A phone agent stopped
// taking phone jobs after an upgrade: the script mounts dialfd's socket only
// if it finds it, said nothing when it didn't, skipped "same image" containers
// that lacked the mount, and couldn't tell a stale socket or a permission
// problem from anything else. These run the REAL script against a stub
// `docker` (which records every call and plays back container state) and a
// real Unix socket standing in for dialfd — and pin that hosts WITHOUT DialF
// see the same container actions as before.

const SCRIPT = path.resolve(__dirname, "../scripts/vox-upgrade.sh");
let dir = "";
let sock = "";
let sockServer: net.Server;

const STUB_DOCKER = `#!/bin/bash
echo "docker $*" >> "$VU_LOG"
case "$1" in
  info) [ -n "\${DOCKER_DENIED:-}" ] && { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }; echo ok ;;
  ps) echo "\${RUNNING_ID:-}" ;;
  image) echo "\${LATEST_IMAGE:-sha-new}" ;;
  inspect)
    case "$*" in
      *"{{.Image}}"*) [ -n "\${IMAGE_INSPECT_FAIL:-}" ] && exit 1; echo "\${RUNNING_IMAGE:-sha-old}" ;;
      *"Config.Env"*) [ -n "\${INSPECT_FAIL:-}" ] && exit 1; [ -n "\${PREV_SOCK:-}" ] && echo "VOX_DIALF_SOCKET=$PREV_SOCK"; echo "AGENT_TOKEN=x" ;;
      *"RestartPolicy"*) echo "unless-stopped" ;;
      *) echo "" ;;
    esac ;;
  exec) case "$*" in *stat*) [ -n "\${CONT_INO:-}" ] && echo "$CONT_INO" || exit 1 ;; *) exit 0 ;; esac ;;
  logs) [ -n "\${PROBE_LINE:-}" ] && echo "$PROBE_LINE"; echo "[Daemon] Heartbeat sent" ;;
  run) echo "newcontainer000111" ;;
  *) ;;
esac
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
const STUB_IP = `#!/bin/bash
exit 1
`;

/** Run the real script; returns its output and the docker calls it made. */
function upgrade(env: Record<string, string>, opts: { runner?: boolean; answers?: string; script?: string } = {}) {
  const log = path.join(dir, `calls-${Math.random()}.log`);
  fs.writeFileSync(log, "");
  const envFile = path.join(dir, opts.runner ? "runner.env" : "agent.env");
  const r = spawnSync("bash", [opts.script ?? SCRIPT, envFile], {
    input: opts.answers ?? "",
    encoding: "utf8",
    env: {
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, VU_LOG: log,
      XDG_RUNTIME_DIR: path.join(dir, "no-runtime"), DIALF_CHECK_TRIES: "1", ...env,
    },
    timeout: 30_000,
  });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const actions = calls.filter((c) => /^docker (stop|rm|run|restart)\b/.test(c)).map((c) => c.split(" ")[1]);
  return { out: `${r.stdout}${r.stderr}`, status: r.status, calls, actions };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-upgrade-test-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ps"), STUB_PS, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "ip"), STUB_IP, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "agent.env"), "AGENT_TOKEN=evtest\nVOX_SERVER=http://localhost:5000\n");
  fs.writeFileSync(path.join(dir, "runner.env"), "RUNNER_TOKEN=crtest\nVOX_SERVER=http://localhost:5000\n");
  sock = path.join(dir, "dialfd.sock");
  sockServer = net.createServer().listen(sock);
  await new Promise((r) => sockServer.once("listening", r));
});
afterAll(() => { sockServer?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("hosts WITHOUT DialF: the same container actions as before", () => {
  // The script as it was before this change (main), run against the same stub.
  const original = () => {
    const p = path.join(dir, "orig.sh");
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, execFileSync("git", ["show", "main:scripts/vox-upgrade.sh"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }));
    }
    return p;
  };
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["web agent, same image", { RUNNING_ID: "abc", RUNNING_IMAGE: "sha-new", LATEST_IMAGE: "sha-new" }, false],
    ["web agent, new image", { RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new" }, false],
    ["clash runner, new image", { RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new" }, true],
  ];
  for (const [name, env, runner] of cases) {
    it(name, () => {
      const before = upgrade(env, { runner, script: original() });
      const after = upgrade(env, { runner });
      expect(after.status).toBe(0);
      expect(after.actions).toEqual(before.actions);                       // stop/rm/run unchanged
      const runOf = (r: typeof after) => r.calls.find((c) => c.startsWith("docker run"));
      expect(runOf(after)).toEqual(runOf(before));                           // same container config
      expect(after.out).not.toMatch(/WARNING|Restart|recreat|Continue|\(y\/n\)/); // nothing alarming, no prompt
    });
  }
});

describe("hosts WITH DialF", () => {
  it("same image, but the running container lacks the DialF mount: recreated with it", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-new", LATEST_IMAGE: "sha-new", DIALF_SOCKET: sock });
    expect(r.out).toMatch(/wasn't started with it — recreating it/);
    expect(r.actions).toEqual(["stop", "rm", "rm", "run"]);
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain(`VOX_DIALF_SOCKET=${sock}`);
  });

  it("same path but dialfd recreated its socket (stale inode): restarted, and the new check read since then", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-new", LATEST_IMAGE: "sha-new", PREV_SOCK: sock, DIALF_SOCKET: sock, CONT_INO: "1", PROBE_LINE: "[Daemon] DialF probe: ok (v0.3.16)" });
    expect(r.out).toMatch(/DialF socket is stale/);
    expect(r.actions).toEqual(["restart"]);
    // Unix seconds, not a bare datetime (which Docker reads as LOCAL time).
    expect(r.calls.some((c) => /^docker logs --since \d{10} abc$/.test(c))).toBe(true);
    expect(r.out).toMatch(/DialF check inside the container: OK/);
  });

  it("same path, same inode: left alone (no needless restart)", () => {
    const ino = String(fs.statSync(sock).ino);
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-new", LATEST_IMAGE: "sha-new", PREV_SOCK: sock, DIALF_SOCKET: sock, CONT_INO: ino });
    expect(r.actions).toEqual([]);
    expect(r.out).toMatch(/Already running the latest image/);
  });

  it("the old container had DialF and none is found now: asks BEFORE stopping it, and 'n' leaves it running", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", PREV_SOCK: "/run/user/1001/dialfd.sock" }, { answers: "n\n" });
    expect(r.out).toMatch(/WON'T take phone jobs/);
    expect(r.out).toMatch(/Leaving the running vox-eval-agentd as it is/);
    expect(r.actions).toEqual([]);
  });

  it("reports what the agent's own DialF check says after launch — e.g. no permission", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", DIALF_SOCKET: sock, PROBE_LINE: "[Daemon] DialF probe: unavailable (no permission to open the dialfd socket x)" });
    expect(r.out).toMatch(/WARNING: DialF check inside the container FAILED: unavailable \(no permission to open the dialfd socket x\)/);
  });
});

describe("VOX_LINK_TYPE (network tags — host link detection, design 2026-10-22)", () => {
  it("a known VOX_LINK_TYPE in the environment is passed to the agent container", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_LINK_TYPE: "wifi" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_LINK_TYPE=wifi");
  });

  it("an invalid VOX_LINK_TYPE is ignored — not forwarded (host_link_type falls through, finds nothing here)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_LINK_TYPE: "5g" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });

  it("unset VOX_LINK_TYPE and no real route (stub ip): nothing forwarded, run unaffected", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new" });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });

  it("not forwarded to vox-clash-runner (it doesn't report network tags)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_LINK_TYPE: "wifi" }, { runner: true });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_LINK_TYPE");
  });
});

describe("VOX_PUBLIC_IP_ON_IFACE (network tags part 2 — host interface detection, design 2026-10-22)", () => {
  it("a known VOX_PUBLIC_IP_ON_IFACE in the environment is passed to the agent container", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_PUBLIC_IP_ON_IFACE: "true" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_PUBLIC_IP_ON_IFACE=true");
  });

  it("false is passed through too (not just truthy values)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_PUBLIC_IP_ON_IFACE: "false" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).toContain("VOX_PUBLIC_IP_ON_IFACE=false");
  });

  it("an invalid VOX_PUBLIC_IP_ON_IFACE is ignored — not forwarded (host_public_ip_on_iface falls through, finds nothing here)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_PUBLIC_IP_ON_IFACE: "maybe" });
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
  });

  it("unset VOX_PUBLIC_IP_ON_IFACE and no real route (stub ip): nothing forwarded, run unaffected", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new" });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("docker run"))).not.toContain("VOX_PUBLIC_IP_ON_IFACE");
  });

  it("not forwarded to vox-clash-runner (it doesn't report network tags)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", VOX_PUBLIC_IP_ON_IFACE: "true" }, { runner: true });
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
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", PS_DIALF_UID: "4321" });
    expect(r.out).toMatch(/dialfd is running as '(uid 4321|[^']+)', but this script runs as '.+' and has no permission to see/);
  });

  it("dialfd running as THIS user (by UID — a long name is truncated by ps) is not called a permission problem", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", PS_DIALF_UID: String(process.getuid?.() ?? 1000) });
    expect(r.out).toMatch(/dialfd is running, but its socket isn't in the usual places/);
    expect(r.out).not.toMatch(/no permission to see/);
  });

  it("DIALF_SOCKET set but nothing listening: names the setting, not generic advice", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", DIALF_SOCKET: path.join(dir, "nope.sock") });
    expect(r.out).toMatch(/DIALF_SOCKET=.*nope\.sock is set, but nothing is listening there/);
  });

  it("a failing docker inspect mid-run doesn't abort the upgrade (set -euo pipefail)", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", INSPECT_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.actions).toContain("run");
  });

  it("…nor does a failing image inspect (#250 review)", () => {
    const r = upgrade({ RUNNING_ID: "abc", LATEST_IMAGE: "sha-new", IMAGE_INSPECT_FAIL: "1" });
    expect(r.calls.some((c) => c.includes("{{.Image}}"))).toBe(true);
    // It carries on (an unknown image counts as "not the latest") and upgrades.
    expect(r.status).toBe(0);
    expect(r.actions).toContain("run");
  });

  it("the DialF prompt with no terminal (EOF) answers no: the running container is left alone, the run doesn't die", () => {
    const r = upgrade({ RUNNING_ID: "abc", RUNNING_IMAGE: "sha-old", LATEST_IMAGE: "sha-new", PREV_SOCK: "/run/user/1001/dialfd.sock" }, { answers: "" });
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
