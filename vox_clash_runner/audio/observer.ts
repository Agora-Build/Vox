// observer.ts — Taps PipeWire monitor streams for audio-health metrics, stereo
// WAV recording (moderator mixed in), and Agora RTC broadcast.

import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { startBroadcast, type BroadcastConfig, type BroadcastHandle } from "./broadcaster.js";
import { SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE, SOX_RAW_ARGS } from "./config.js";

export interface ObserverMetrics {
  responseLatencyMedian: number | null;
  responseLatencySd: number | null;
  interruptLatencyMedian: number | null;
  interruptLatencySd: number | null;
  ttftMedian: number | null;
  turnCount: number;
  overlapPercent: number | null;
  // Audio-health: did this agent actually produce sound? Computed from the raw
  // capture, so a silent agent / dead pipeline is detectable on the match record.
  audioRms: number | null;        // 0..1 normalized RMS over the whole capture
  talkTimeSeconds: number | null; // seconds of frames above the silence threshold
}

export interface ObserverResult {
  metricsA: ObserverMetrics;
  metricsB: ObserverMetrics;
  recordingPath: string | null;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Cross-wire (agents hear each other) — loopback lifecycle owned per match
// ---------------------------------------------------------------------------

/** Parse the module id printed by `pactl load-module` (a bare integer). */
export function parseLoadedModuleId(pactlOutput: string): number | null {
  const id = parseInt(pactlOutput.trim(), 10);
  return Number.isFinite(id) && id >= 0 ? id : null;
}

/**
 * Parse `pactl list short modules` output and return the ids of all
 * module-loopback rows. Lines look like: "<id>\tmodule-loopback\t<args...>".
 */
export function parseLoopbackModuleIds(listOutput: string): number[] {
  const ids: number[] = [];
  for (const line of listOutput.split("\n")) {
    const cols = line.split("\t");
    if (cols.length >= 2 && cols[1].trim() === "module-loopback") {
      const id = parseInt(cols[0], 10);
      if (Number.isFinite(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * Defensively unload ALL module-loopback instances. Called before wiring a new
 * match so a crashed previous match (warm pool) can never leave stale loopbacks
 * feeding doubled/echoing audio into the next match.
 */
export function unloadAllLoopbacks(): void {
  let listing = "";
  try {
    listing = execSync("pactl list short modules").toString();
  } catch (err) {
    console.warn("[Observer] Could not list modules for loopback cleanup:", err);
    return;
  }
  const stale = parseLoopbackModuleIds(listing);
  for (const id of stale) {
    try {
      execSync(`pactl unload-module ${id}`);
      console.log(`[Observer] Unloaded stale loopback module ${id}`);
    } catch (err) {
      console.warn(`[Observer] Failed to unload loopback module ${id}:`, err);
    }
  }
}

/**
 * Cross-wire PipeWire sinks so agents hear each other:
 *
 *   Sink_A_Out.monitor → Sink_B_In  (B hears what A speaks)
 *   Sink_B_Out.monitor → Sink_A_In  (A hears what B speaks)
 *
 * Called after both browsers have connected and claimed their sinks.
 * THROWS on failure — a match where the agents can't hear each other is
 * garbage data, so the caller must fail the match rather than run it deaf.
 * Returns the loaded module ids; pass them to unwireAudio() at teardown.
 */
export function crossWireAudio(): number[] {
  console.log("[Observer] Cross-wiring audio via PulseAudio loopback...");
  // Clean slate: no loopbacks may pre-exist (previous match leak / crash).
  unloadAllLoopbacks();

  const moduleIds: number[] = [];
  try {
    // A's output → B's input: B hears what A speaks
    const outA = execSync(
      "pactl load-module module-loopback source=Sink_A_Out.monitor sink=Sink_B_In latency_msec=20",
    ).toString();
    const idA = parseLoadedModuleId(outA);
    if (idA !== null) moduleIds.push(idA);

    // B's output → A's input: A hears what B speaks
    const outB = execSync(
      "pactl load-module module-loopback source=Sink_B_Out.monitor sink=Sink_A_In latency_msec=20",
    ).toString();
    const idB = parseLoadedModuleId(outB);
    if (idB !== null) moduleIds.push(idB);

    console.log(`[Observer] Cross-wiring complete (loopback modules: ${moduleIds.join(", ")})`);
    return moduleIds;
  } catch (err) {
    // Don't leave a half-wired graph behind (e.g. A→B loaded, B→A failed).
    unwireAudio(moduleIds);
    unloadAllLoopbacks();
    throw new Error(`Cross-wire failed — agents would not hear each other: ${err instanceof Error ? err.message : err}`);
  }
}

/** Unload the loopback modules created by crossWireAudio (per-match teardown). */
export function unwireAudio(moduleIds: number[]): void {
  for (const id of moduleIds) {
    try {
      execSync(`pactl unload-module ${id}`);
    } catch (err) {
      console.warn(`[Observer] Failed to unload loopback module ${id}:`, err);
    }
  }
  if (moduleIds.length > 0) {
    console.log(`[Observer] Unwired ${moduleIds.length} loopback module(s)`);
  }
}

// ---------------------------------------------------------------------------
// Audio-health stats (pure, unit-testable)
// ---------------------------------------------------------------------------

export interface PcmStats {
  /** Normalized RMS over the whole buffer (0..1). */
  rms: number;
  /** Fraction of 100ms windows whose RMS exceeds the silence threshold (0..1). */
  activeRatio: number;
  /** activeRatio expressed in seconds of audio. */
  activeSeconds: number;
  durationSeconds: number;
}

/** Windows quieter than this normalized RMS (~ -40 dBFS) count as silence. */
export const SILENCE_RMS_THRESHOLD = 0.01;

/**
 * Compute RMS + talk-time stats over a raw s16le mono PCM buffer.
 * Pure function so the math is unit-testable without PipeWire.
 */
export function computePcmStats(pcm: Buffer, sampleRate: number = SAMPLE_RATE): PcmStats {
  const totalSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const durationSeconds = totalSamples / sampleRate;
  if (totalSamples === 0) {
    return { rms: 0, activeRatio: 0, activeSeconds: 0, durationSeconds: 0 };
  }

  const windowSamples = Math.max(1, Math.floor(sampleRate / 10)); // 100ms windows
  let sumSquares = 0;
  let windowSumSquares = 0;
  let windowCount = 0;
  let activeWindows = 0;
  let totalWindows = 0;

  for (let i = 0; i < totalSamples; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    const sq = sample * sample;
    sumSquares += sq;
    windowSumSquares += sq;
    windowCount++;
    if (windowCount === windowSamples) {
      totalWindows++;
      if (Math.sqrt(windowSumSquares / windowCount) > SILENCE_RMS_THRESHOLD) {
        activeWindows++;
      }
      windowSumSquares = 0;
      windowCount = 0;
    }
  }
  // Trailing partial window
  if (windowCount > 0) {
    totalWindows++;
    if (Math.sqrt(windowSumSquares / windowCount) > SILENCE_RMS_THRESHOLD) {
      activeWindows++;
    }
  }

  const activeRatio = totalWindows > 0 ? activeWindows / totalWindows : 0;
  return {
    rms: Math.sqrt(sumSquares / totalSamples),
    activeRatio,
    activeSeconds: activeRatio * durationSeconds,
    durationSeconds,
  };
}

function statsForFile(filePath: string): PcmStats | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return computePcmStats(fs.readFileSync(filePath));
  } catch (err) {
    console.warn(`[Observer] Could not compute stats for ${filePath}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordingResult {
  recordingPath: string | null;
  statsA: PcmStats | null;
  statsB: PcmStats | null;
}

/**
 * Start recording from both agent output monitors:
 *   Agent A (Sink_A_Out.monitor) → left channel
 *   Agent B (Sink_B_Out.monitor) → right channel
 * If `moderatorRawPath` exists at stop time, the moderator's voice is mixed
 * into both channels so the recording captures the WHOLE match voice.
 */
export function startRecording(
  outputDir: string,
  moderatorRawPath?: string,
): {
  stop: () => RecordingResult;
} {
  const recA = path.join(outputDir, "agent_a.raw");
  const recB = path.join(outputDir, "agent_b.raw");
  const stereoTmp = path.join(outputDir, "agents_stereo.wav");
  const moderatorTmp = path.join(outputDir, "moderator_stereo.wav");
  const stereoOut = path.join(outputDir, "clash_recording.wav");

  fs.mkdirSync(outputDir, { recursive: true });

  let procA: ChildProcess | null = null;
  let procB: ChildProcess | null = null;

  try {
    procA = spawn("parec", [
      "--device=Sink_A_Out.monitor",
      "--format=s16le",
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      "--file-format=raw",
      "--latency-msec=50",
      recA,
    ]);

    procB = spawn("parec", [
      "--device=Sink_B_Out.monitor",
      "--format=s16le",
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      "--file-format=raw",
      "--latency-msec=50",
      recB,
    ]);
  } catch (err) {
    console.error("[Observer] Failed to start recording:", err);
  }

  return {
    stop: (): RecordingResult => {
      let recordingPath: string | null = null;
      let statsA: PcmStats | null = null;
      let statsB: PcmStats | null = null;
      try {
        procA?.kill("SIGTERM");
        procB?.kill("SIGTERM");

        execSync("sleep 0.5");

        // Audio-health stats BEFORE the raw files are consumed/deleted.
        statsA = statsForFile(recA);
        statsB = statsForFile(recB);

        if (fs.existsSync(recA) && fs.existsSync(recB)) {
          execSync(
            `sox -M ${SOX_RAW_ARGS} ${recA} ${SOX_RAW_ARGS} ${recB} ${stereoTmp}`,
          );

          // Mix the moderator into both channels ("whole voice captured").
          // Threshold: > 1s of audio, else treat as absent.
          const minModeratorBytes = SAMPLE_RATE * BYTES_PER_SAMPLE;
          if (
            moderatorRawPath &&
            fs.existsSync(moderatorRawPath) &&
            fs.statSync(moderatorRawPath).size > minModeratorBytes
          ) {
            execSync(`sox ${SOX_RAW_ARGS} ${moderatorRawPath} ${moderatorTmp} remix 1 1`);
            execSync(`sox -m ${stereoTmp} ${moderatorTmp} ${stereoOut}`);
            fs.unlinkSync(stereoTmp);
            fs.unlinkSync(moderatorTmp);
            console.log(`[Observer] Recording saved (A=L, B=R, moderator mixed in): ${stereoOut}`);
          } else {
            fs.renameSync(stereoTmp, stereoOut);
            console.log(`[Observer] Stereo recording saved (no moderator audio): ${stereoOut}`);
          }

          fs.unlinkSync(recA);
          fs.unlinkSync(recB);
          recordingPath = stereoOut;
        }
      } catch (err) {
        console.error("[Observer] Error stopping recording:", err);
      }
      return { recordingPath, statsA, statsB };
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Build per-agent metrics. Turn-level conversation metrics (latency,
 * interrupts) are a known gap — see designs/CLASH_DESIGN.md §7. Audio-health
 * (RMS + talk time) is real, computed from each agent's raw capture, so a
 * silent agent or dead pipeline is visible on the completed match.
 */
export function computeMetrics(
  statsA: PcmStats | null,
  statsB: PcmStats | null,
): { metricsA: ObserverMetrics; metricsB: ObserverMetrics } {
  const base: ObserverMetrics = {
    responseLatencyMedian: null,
    responseLatencySd: null,
    interruptLatencyMedian: null,
    interruptLatencySd: null,
    ttftMedian: null,
    turnCount: 0,
    overlapPercent: null,
    audioRms: null,
    talkTimeSeconds: null,
  };

  const withStats = (stats: PcmStats | null): ObserverMetrics => ({
    ...base,
    audioRms: stats ? Math.round(stats.rms * 10000) / 10000 : null,
    talkTimeSeconds: stats ? Math.round(stats.activeSeconds * 10) / 10 : null,
  });

  return {
    metricsA: withStats(statsA),
    metricsB: withStats(statsB),
  };
}

// ---------------------------------------------------------------------------
// Observer orchestration
// ---------------------------------------------------------------------------

/**
 * Start the full observer: recording + optional Agora RTC broadcast.
 * The broadcaster tees the moderator's RTC audio to `moderator_out.raw` in
 * outputDir so stopRecording can mix it into the final WAV.
 */
export async function startObserver(
  outputDir: string,
  broadcastConfig?: BroadcastConfig,
): Promise<{
  stopAll: () => Promise<RecordingResult>;
}> {
  fs.mkdirSync(outputDir, { recursive: true });
  const moderatorRawPath = path.join(outputDir, "moderator_out.raw");

  const recorder = startRecording(outputDir, moderatorRawPath);
  let broadcast: BroadcastHandle | null = null;

  if (broadcastConfig) {
    try {
      broadcast = await startBroadcast({ ...broadcastConfig, moderatorTeePath: moderatorRawPath });
      console.log("[Observer] Broadcast started");
    } catch (err) {
      console.error("[Observer] Broadcast start failed (continuing without):", err);
    }
  }

  return {
    stopAll: async (): Promise<RecordingResult> => {
      if (broadcast) {
        await broadcast.stop().catch((err: unknown) =>
          console.error("[Observer] Broadcast stop error:", err)
        );
      }
      return recorder.stop();
    },
  };
}
