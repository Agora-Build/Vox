// observer.ts — Taps PipeWire monitor streams for VAD, turn detection,
// latency metrics, stereo WAV recording, and Agora RTC broadcast.

import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { startBroadcast, type BroadcastConfig, type BroadcastHandle } from "./broadcaster.js";

export interface ObserverMetrics {
  responseLatencyMedian: number | null;
  responseLatencySd: number | null;
  interruptLatencyMedian: number | null;
  interruptLatencySd: number | null;
  ttftMedian: number | null;
  turnCount: number;
  overlapPercent: number | null;
}

export interface ObserverResult {
  metricsA: ObserverMetrics;
  metricsB: ObserverMetrics;
  recordingPath: string | null;
  durationSeconds: number;
}

/**
 * Cross-wire PipeWire sinks so agents hear each other.
 *
 * Virtual_Sink_A.monitor → Browser B's source input
 * Virtual_Sink_B.monitor → Browser A's source input
 *
 * This is called after both browsers have connected and claimed their sinks.
 */
export function crossWireAudio(): void {
  console.log("[Observer] Cross-wiring PipeWire audio...");
  try {
    // List current nodes to find browser source nodes
    const dump = execSync("pw-dump", { encoding: "utf-8" });
    console.log("[Observer] PipeWire nodes available. Cross-wiring with pw-link...");

    // Link Virtual_Sink_A monitor → Browser B input
    // Link Virtual_Sink_B monitor → Browser A input
    // Note: Exact port names depend on PipeWire runtime state.
    // We use pw-link with port name patterns.
    try {
      execSync("pw-link Virtual_Sink_A:monitor_FL Virtual_Sink_B:input_FL 2>/dev/null || true");
      execSync("pw-link Virtual_Sink_A:monitor_FR Virtual_Sink_B:input_FR 2>/dev/null || true");
      execSync("pw-link Virtual_Sink_B:monitor_FL Virtual_Sink_A:input_FL 2>/dev/null || true");
      execSync("pw-link Virtual_Sink_B:monitor_FR Virtual_Sink_A:input_FR 2>/dev/null || true");
    } catch {
      // pw-link may fail if ports aren't ready yet — that's ok for now
    }

    console.log("[Observer] Cross-wiring complete");
  } catch (err) {
    console.error("[Observer] Failed to cross-wire:", err);
  }
}

/**
 * Start recording a stereo WAV file from both monitor streams.
 * Agent A (Virtual_Sink_A.monitor) → left channel
 * Agent B (Virtual_Sink_B.monitor) → right channel
 *
 * Uses parec (PulseAudio/PipeWire client) to capture monitor streams,
 * then sox to merge into stereo.
 */
export function startRecording(outputDir: string): {
  stop: () => string | null;
} {
  const recA = path.join(outputDir, "agent_a.raw");
  const recB = path.join(outputDir, "agent_b.raw");
  const stereoOut = path.join(outputDir, "clash_recording.wav");

  fs.mkdirSync(outputDir, { recursive: true });

  // Record from each monitor stream
  let procA: ChildProcess | null = null;
  let procB: ChildProcess | null = null;

  try {
    procA = spawn("parec", [
      "--device=Virtual_Sink_A.monitor",
      "--format=s16le",
      "--rate=16000",
      "--channels=1",
      "--file-format=raw",
      recA,
    ]);

    procB = spawn("parec", [
      "--device=Virtual_Sink_B.monitor",
      "--format=s16le",
      "--rate=16000",
      "--channels=1",
      "--file-format=raw",
      recB,
    ]);
  } catch (err) {
    console.error("[Observer] Failed to start recording:", err);
  }

  return {
    stop: () => {
      try {
        procA?.kill("SIGTERM");
        procB?.kill("SIGTERM");

        // Wait a moment for files to flush
        execSync("sleep 0.5");

        // Merge into stereo WAV using sox
        if (fs.existsSync(recA) && fs.existsSync(recB)) {
          execSync(
            `sox -M ` +
            `-r 16000 -e signed -b 16 -c 1 ${recA} ` +
            `-r 16000 -e signed -b 16 -c 1 ${recB} ` +
            `${stereoOut}`
          );
          // Clean up raw files
          fs.unlinkSync(recA);
          fs.unlinkSync(recB);
          console.log(`[Observer] Stereo recording saved: ${stereoOut}`);
          return stereoOut;
        }
      } catch (err) {
        console.error("[Observer] Error stopping recording:", err);
      }
      return null;
    },
  };
}

/**
 * Compute basic metrics from the recorded audio.
 * MVP: Returns placeholder metrics. Full VAD + turn detection is Phase 2.
 */
export function computeMetrics(
  recordingPath: string | null,
  durationSeconds: number,
): { metricsA: ObserverMetrics; metricsB: ObserverMetrics } {
  // MVP: Return basic structure. Full analysis pipeline (VAD, turn detection,
  // latency computation) will be added in Phase 4.
  const emptyMetrics: ObserverMetrics = {
    responseLatencyMedian: null,
    responseLatencySd: null,
    interruptLatencyMedian: null,
    interruptLatencySd: null,
    ttftMedian: null,
    turnCount: 0,
    overlapPercent: null,
  };

  return {
    metricsA: { ...emptyMetrics },
    metricsB: { ...emptyMetrics },
  };
}

/**
 * Start the full observer: recording + optional Agora RTC broadcast.
 * Returns handles to stop both.
 */
export async function startObserver(
  outputDir: string,
  broadcastConfig?: BroadcastConfig,
): Promise<{
  stopAll: () => Promise<string | null>;
}> {
  const recorder = startRecording(outputDir);
  let broadcast: BroadcastHandle | null = null;

  if (broadcastConfig) {
    try {
      broadcast = await startBroadcast(broadcastConfig);
      console.log("[Observer] Broadcast started");
    } catch (err) {
      console.error("[Observer] Broadcast start failed (continuing without):", err);
    }
  }

  return {
    stopAll: async () => {
      if (broadcast) {
        await broadcast.stop().catch((err: unknown) =>
          console.error("[Observer] Broadcast stop error:", err)
        );
      }
      return recorder.stop();
    },
  };
}
