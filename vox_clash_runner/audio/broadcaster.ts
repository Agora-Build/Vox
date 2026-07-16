// broadcaster.ts — Publishes per-agent audio to an Agora RTC channel using the
// native C++ agora-broadcaster binary. Spawns two parec|agora-broadcaster pairs,
// one for each agent, so spectators (and future avatar systems) receive
// individual audio tracks with separate UIDs. Also runs the agora-receiver
// (moderator → agents path) and tees the moderator PCM for the recording mix.

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { SAMPLE_RATE, CHANNELS, FORMAT, FORMAT_LABEL, parecArgs, pacatArgs } from "./config.js";

const DEBUG = !!process.env.LOCAL_DEBUG;
if (DEBUG) {
  try { fs.mkdirSync("/app/output", { recursive: true }); } catch {}
}

/** Fallback moderator uid when the server assignment doesn't supply one. */
export const DEFAULT_MODERATOR_UID = 500;

export interface BroadcastConfig {
  appId: string;
  channelName: string;
  tokenA: string;      // RTC token for Agent A publisher (uid 100)
  tokenB: string;      // RTC token for Agent B publisher (uid 200)
  uidA: number;         // 100
  uidB: number;         // 200
  receiverToken: string; // RTC token for receiver (uid 300, audience)
  receiverUid: number;   // 300
  // The moderator's RTC uid — the receiver passes ONLY this uid's audio into
  // the agents' mic sinks. Delivered by the server assignment so it can never
  // drift from the uid the ConvoAI moderator actually joins with.
  moderatorUid?: number;
  // When set, the moderator's PCM is tee'd to this raw file so the recording
  // can mix the moderator's voice into the final WAV (whole-voice capture).
  moderatorTeePath?: string;
}

/** Which pipeline components survived startup — for logging/diagnostics. */
export interface BroadcastStatus {
  agentA: boolean;
  agentB: boolean;
  receiver: boolean;
}

export interface BroadcastHandle {
  stop: () => Promise<void>;
  status: BroadcastStatus;
}

const BROADCASTER_BIN = process.env.BROADCASTER_BIN || "/app/agora-broadcaster";
const RECEIVER_BIN = process.env.RECEIVER_BIN || "/app/agora-receiver";
const STARTUP_GUARD_MS = 3000;

function debugPath(name: string): string {
  return `/app/output/debug_${name}_${FORMAT_LABEL}.raw`;
}

/**
 * Build the argv for the agora-receiver binary. Exported for unit testing —
 * the --filterUid value is the moderator↔agents audio contract.
 */
export function buildReceiverArgs(config: BroadcastConfig): string[] {
  return [
    "--appId", config.appId,
    "--token", config.receiverToken,
    "--channelId", config.channelName,
    "--userId", String(config.receiverUid),
    "--filterUid", String(config.moderatorUid ?? DEFAULT_MODERATOR_UID),
    "--sampleRate", String(SAMPLE_RATE),
    "--numOfChannels", String(CHANNELS),
  ];
}

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
  const capture = spawn("parec", [...parecArgs(device), "--latency-msec=50"]);

  const broadcaster = spawn(BROADCASTER_BIN, [
    "--appId", config.appId,
    "--token", token,
    "--channelId", config.channelName,
    "--userId", String(uid),
    "--sampleRate", String(SAMPLE_RATE),
    "--numOfChannels", String(CHANNELS),
  ]);

  // Suppress EPIPE if the broadcaster dies while parec is still writing.
  broadcaster.stdin.on("error", () => {});

  if (DEBUG) {
    const suffix = label === "AgentA" ? "agent_a_out" : "agent_b_out";
    const dumpPath = debugPath(suffix);
    const dumpStream = fs.createWriteStream(dumpPath);
    capture.stdout.on("data", (chunk: Buffer) => {
      broadcaster.stdin.write(chunk);
      dumpStream.write(chunk);
    });
    capture.stdout.on("end", () => dumpStream.end());
    console.log(`[DEBUG] Dumping ${label} output audio → ${dumpPath}`);
  } else {
    capture.stdout.pipe(broadcaster.stdin);
  }

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

/**
 * Watch a just-spawned process for STARTUP_GUARD_MS; resolves false if it
 * exits non-zero (or errors) within the window, true otherwise. Per-component
 * guards keep one failing component from taking down the others — e.g. a dead
 * Agent A broadcaster must not prevent the receiver from delivering the
 * moderator's voice to the agents.
 */
function guardStartup(proc: ChildProcess, label: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(true), STARTUP_GUARD_MS);
    proc.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        console.error(`[Broadcaster] ${label} FAILED to start (exit code ${code})`);
        resolve(false);
      }
    });
    proc.once("error", (err) => {
      clearTimeout(timeout);
      console.error(`[Broadcaster] ${label} FAILED to spawn:`, err);
      resolve(false);
    });
  });
}

function killAgent(agent: AgentBroadcast): Promise<void> {
  return new Promise((resolve) => {
    let closed = 0;
    let done = false;
    const finish = () => {
      if (done || closed < 2) return;
      done = true;
      clearTimeout(force);
      resolve();
    };
    // Force-kill fallback ALWAYS resolves — teardown must never hang the
    // runner, whatever state the processes are in.
    const force = setTimeout(() => {
      agent.broadcaster.kill("SIGKILL");
      agent.capture.kill("SIGKILL");
      if (!done) {
        done = true;
        resolve();
      }
    }, 3000);
    for (const proc of [agent.broadcaster, agent.capture]) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        // Already exited (e.g. failed its startup guard in degraded mode) —
        // its close event fired long ago, so count it now instead of waiting
        // for a listener that can never fire.
        closed++;
      } else {
        proc.once("close", () => {
          closed++;
          finish();
        });
        proc.kill("SIGTERM");
      }
    }
    finish();
  });
}

/**
 * Start broadcasting both agents' audio to the Agora spectator channel and the
 * moderator receiver. Each agent publishes on its own UID so spectators hear
 * both; the receiver pipes ONLY the moderator's audio into both agents' mic
 * sinks. Components are guarded independently — any single failure degrades
 * the match (loudly logged) instead of silently killing the other paths.
 */
export async function startBroadcast(config: BroadcastConfig): Promise<BroadcastHandle> {
  console.log(`[Broadcaster] Starting dual-agent broadcast to channel ${config.channelName}`);
  console.log(`[Broadcaster]   Agent A: uid=${config.uidA} → Sink_A_Out.monitor`);
  console.log(`[Broadcaster]   Agent B: uid=${config.uidB} → Sink_B_Out.monitor`);

  const agentA = spawnAgentBroadcaster(
    "Sink_A_Out.monitor", config, config.tokenA, config.uidA, "AgentA",
  );
  const agentB = spawnAgentBroadcaster(
    "Sink_B_Out.monitor", config, config.tokenB, config.uidB, "AgentB",
  );

  // Spawn RTC receiver: subscribes to the channel and forwards ONLY the
  // moderator's frames (filterUid) into both agents' mic sinks.
  const moderatorUid = config.moderatorUid ?? DEFAULT_MODERATOR_UID;
  console.log(`[Broadcaster] Starting RTC receiver: uid=${config.receiverUid}, moderator uid=${moderatorUid} → both sinks`);
  const receiver = spawn(RECEIVER_BIN, buildReceiverArgs(config));

  // Pipe received audio to both agent sinks
  const pacatA = spawn("pacat", pacatArgs("Sink_A_In"));
  const pacatB = spawn("pacat", pacatArgs("Sink_B_In"));

  // Suppress EPIPE errors during shutdown (pacat killed before receiver stops writing)
  pacatA.stdin.on("error", () => {});
  pacatB.stdin.on("error", () => {});

  // Tee the moderator PCM for the recording mix (whole-voice capture). This is
  // always on when the observer provides a path — not just in DEBUG.
  let moderatorTee: fs.WriteStream | null = null;
  if (config.moderatorTeePath) {
    try {
      moderatorTee = fs.createWriteStream(config.moderatorTeePath);
      console.log(`[Broadcaster] Teeing moderator audio → ${config.moderatorTeePath}`);
    } catch (err) {
      console.warn("[Broadcaster] Could not open moderator tee:", err);
    }
  }

  let agentAInDump: ChildProcess | null = null;
  let agentBInDump: ChildProcess | null = null;
  if (DEBUG) {
    const aInPath = debugPath("agent_a_in");
    agentAInDump = spawn("parec", parecArgs("Sink_A_In.monitor"),
      { stdio: ["ignore", fs.openSync(aInPath, "w"), "ignore"] });
    console.log(`[DEBUG] Dumping Agent A mic input → ${aInPath}`);

    const bInPath = debugPath("agent_b_in");
    agentBInDump = spawn("parec", parecArgs("Sink_B_In.monitor"),
      { stdio: ["ignore", fs.openSync(bInPath, "w"), "ignore"] });
    console.log(`[DEBUG] Dumping Agent B mic input → ${bInPath}`);
  }

  receiver.stdout.on("data", (chunk: Buffer) => {
    try {
      pacatA.stdin.write(chunk);
      pacatB.stdin.write(chunk);
      moderatorTee?.write(chunk);
    } catch {}
  });

  receiver.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[agora-receiver] ${msg}`);
  });
  receiver.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Broadcaster] Receiver exited with code ${code} — agents will NOT hear the moderator`);
    }
    pacatA.stdin.end();
    pacatB.stdin.end();
    moderatorTee?.end();
    agentAInDump?.kill("SIGTERM");
    agentBInDump?.kill("SIGTERM");
  });

  // Independent startup guards: one component failing must not kill the rest.
  const [okA, okB, okReceiver] = await Promise.all([
    guardStartup(agentA.broadcaster, "Agent A broadcaster"),
    guardStartup(agentB.broadcaster, "Agent B broadcaster"),
    guardStartup(receiver, "Receiver (moderator → agents)"),
  ]);
  const status: BroadcastStatus = { agentA: okA, agentB: okB, receiver: okReceiver };
  if (!okA || !okB || !okReceiver) {
    console.error(`[Broadcaster] DEGRADED audio pipeline: ${JSON.stringify(status)}`);
  } else {
    console.log("[Broadcaster] Both agents publishing + receiver active");
  }

  if (DEBUG) {
    console.log(`[DEBUG] Audio debug dumps enabled (${FORMAT}, ${SAMPLE_RATE}Hz, ${CHANNELS}ch):`);
    console.log(`[DEBUG]   ${debugPath("agent_a_in")}     — what Agent A mic hears`);
    console.log(`[DEBUG]   ${debugPath("agent_b_in")}     — what Agent B mic hears`);
    console.log(`[DEBUG]   ${debugPath("agent_a_out")}    — what Agent A speaks`);
    console.log(`[DEBUG]   ${debugPath("agent_b_out")}    — what Agent B speaks`);
    console.log(`[DEBUG] Play:    ffplay -f ${FORMAT} -ar ${SAMPLE_RATE} -ch_layout mono <file>`);
    console.log(`[DEBUG] Convert: ffmpeg -f ${FORMAT} -ar ${SAMPLE_RATE} -ch_layout mono -i <file> <file>.wav`);
  }

  return {
    status,
    stop: async () => {
      console.log("[Broadcaster] Stopping...");
      receiver.kill("SIGTERM");
      pacatA.kill("SIGTERM");
      pacatB.kill("SIGTERM");
      agentAInDump?.kill("SIGTERM");
      agentBInDump?.kill("SIGTERM");
      // Await the moderator tee's flush — stopRecording reads moderator_out.raw
      // right after stop() returns, so an unflushed stream would mix truncated
      // (or missing) moderator audio into the recording. Bounded so a stream
      // that already errored can't hang teardown.
      if (moderatorTee) {
        await new Promise<void>((resolve) => {
          const bail = setTimeout(resolve, 2000);
          moderatorTee!.end(() => {
            clearTimeout(bail);
            resolve();
          });
        });
      }
      await Promise.all([killAgent(agentA), killAgent(agentB)]);
      setTimeout(() => {
        receiver.kill("SIGKILL");
        pacatA.kill("SIGKILL");
        pacatB.kill("SIGKILL");
      }, 3000);
      if (DEBUG) {
        console.log("[DEBUG] Audio dumps saved to /app/output/debug_*.raw");
        console.log("[DEBUG] Play:    ffplay -f s16le -ar 16000 -ac 1 <file>.raw");
        console.log("[DEBUG] Convert: ffmpeg -f s16le -ar 16000 -ac 1 -i <file>.raw <file>.wav");
      }
      console.log("[Broadcaster] Stopped");
    },
  };
}
