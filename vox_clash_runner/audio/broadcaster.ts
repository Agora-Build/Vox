// broadcaster.ts — Publishes per-agent audio to an Agora RTC channel using the
// native C++ agora-broadcaster binary. Spawns two parec|agora-broadcaster pairs,
// one for each agent, so spectators (and future avatar systems) receive
// individual audio tracks with separate UIDs.

import { spawn, type ChildProcess } from "child_process";

export interface BroadcastConfig {
  appId: string;
  channelName: string;
  tokenA: string;      // RTC token for Agent A publisher (uid 100)
  tokenB: string;      // RTC token for Agent B publisher (uid 200)
  uidA: number;         // 100
  uidB: number;         // 200
  receiverToken: string; // RTC token for receiver (uid 300, audience)
  receiverUid: number;   // 300
}

export interface BroadcastHandle {
  stop: () => Promise<void>;
}

const BROADCASTER_BIN = process.env.BROADCASTER_BIN || "/app/agora-broadcaster";
const RECEIVER_BIN = process.env.RECEIVER_BIN || "/app/agora-receiver";

interface AgentBroadcast {
  capture: ChildProcess;
  broadcaster: ChildProcess;
  label: string;
}

function spawnAgentBroadcaster(
  device: string,
  config: BroadcastConfig,
  token: string,
  uid: number,
  label: string,
): AgentBroadcast {
  const capture = spawn("parec", [
    `--device=${device}`,
    "--format=s16le",
    "--rate=16000",
    "--channels=1",
    "--raw",
    "--latency-msec=50",
  ]);

  const broadcaster = spawn(BROADCASTER_BIN, [
    "--appId", config.appId,
    "--token", token,
    "--channelId", config.channelName,
    "--userId", String(uid),
    "--sampleRate", "16000",
    "--numOfChannels", "1",
  ]);

  capture.stdout.pipe(broadcaster.stdin);

  capture.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[parec:${label}] ${msg}`);
  });
  broadcaster.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[agora-broadcaster:${label}] ${msg}`);
  });

  broadcaster.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Broadcaster] ${label} exited with code ${code}`);
    }
  });

  return { capture, broadcaster, label };
}

function killAgent(agent: AgentBroadcast): Promise<void> {
  return new Promise((resolve) => {
    let closed = 0;
    const onClose = () => { if (++closed >= 2) resolve(); };
    agent.broadcaster.on("close", onClose);
    agent.capture.on("close", onClose);
    agent.broadcaster.kill("SIGTERM");
    agent.capture.kill("SIGTERM");
    // Force kill after 3s if still alive
    setTimeout(() => {
      agent.broadcaster.kill("SIGKILL");
      agent.capture.kill("SIGKILL");
    }, 3000);
  });
}

/**
 * Start broadcasting both agents' audio to the Agora spectator channel.
 * Each agent publishes on its own UID so spectators hear both, and future
 * avatar systems can subscribe to individual agent audio.
 */
export async function startBroadcast(config: BroadcastConfig): Promise<BroadcastHandle> {
  console.log(`[Broadcaster] Starting dual-agent broadcast to channel ${config.channelName}`);
  console.log(`[Broadcaster]   Agent A: uid=${config.uidA} → Virtual_Sink_A.monitor`);
  console.log(`[Broadcaster]   Agent B: uid=${config.uidB} → Virtual_Sink_B.monitor`);

  const agentA = spawnAgentBroadcaster(
    "Virtual_Sink_A.monitor", config, config.tokenA, config.uidA, "AgentA",
  );
  const agentB = spawnAgentBroadcaster(
    "Virtual_Sink_B.monitor", config, config.tokenB, config.uidB, "AgentB",
  );

  // Brief startup check — if either broadcaster crashes immediately, report it
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, 3000);
    const onExit = (label: string) => (code: number | null) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`${label} broadcaster failed to start (exit code ${code})`));
      }
    };
    agentA.broadcaster.on("exit", onExit("Agent A"));
    agentB.broadcaster.on("exit", onExit("Agent B"));
  });

  // Spawn RTC receiver: subscribes to channel audio (moderator + agents),
  // pipes PCM into both virtual sinks so agent browsers hear everything
  console.log(`[Broadcaster] Starting RTC receiver: uid=${config.receiverUid} → both sinks`);
  const receiver = spawn(RECEIVER_BIN, [
    "--appId", config.appId,
    "--token", config.receiverToken,
    "--channelId", config.channelName,
    "--userId", String(config.receiverUid),
    "--filterUid", "500",  // Only pipe moderator audio to agents (avoid feedback loop)
    "--sampleRate", "16000",
    "--numOfChannels", "1",
  ]);

  // Pipe received audio to both agent sinks
  const pacatA = spawn("pacat", [
    "-d", "Virtual_Sink_A", "--format=s16le", "--rate=16000", "--channels=1",
  ]);
  const pacatB = spawn("pacat", [
    "-d", "Virtual_Sink_B", "--format=s16le", "--rate=16000", "--channels=1",
  ]);

  // Suppress EPIPE errors during shutdown (pacat killed before receiver stops writing)
  pacatA.stdin.on("error", () => {});
  pacatB.stdin.on("error", () => {});

  receiver.stdout.on("data", (chunk: Buffer) => {
    try {
      pacatA.stdin.write(chunk);
      pacatB.stdin.write(chunk);
    } catch {}
  });

  receiver.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[agora-receiver] ${msg}`);
  });
  receiver.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Broadcaster] Receiver exited with code ${code}`);
    }
    pacatA.stdin.end();
    pacatB.stdin.end();
  });

  console.log("[Broadcaster] Both agents publishing + receiver active");

  return {
    stop: async () => {
      console.log("[Broadcaster] Stopping...");
      receiver.kill("SIGTERM");
      pacatA.kill("SIGTERM");
      pacatB.kill("SIGTERM");
      await Promise.all([killAgent(agentA), killAgent(agentB)]);
      // Force kill receiver processes after 3s
      setTimeout(() => {
        receiver.kill("SIGKILL");
        pacatA.kill("SIGKILL");
        pacatB.kill("SIGKILL");
      }, 3000);
      console.log("[Broadcaster] Stopped");
    },
  };
}
