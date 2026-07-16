/**
 * Clash audio pipeline unit tests — imports the REAL runner audio modules
 * (config, observer, broadcaster helpers), unlike clash-runner.test.ts which
 * re-implements logic locally. Covers the pieces of the audio contract that
 * don't need PipeWire: arg builders, loopback module-id parsing (the leak
 * fix), the receiver's moderator uid filter plumbing, and the RMS/talk-time
 * audio-health math.
 */

import { describe, it, expect } from "vitest";
import {
  SAMPLE_RATE,
  CHANNELS,
  FORMAT,
  BYTES_PER_SAMPLE,
  FORMAT_LABEL,
  parecArgs,
  pacatArgs,
  SOX_RAW_ARGS,
} from "../vox_clash_runner/audio/config.js";
import {
  parseLoadedModuleId,
  parseLoopbackModuleIds,
  computePcmStats,
  computeMetrics,
  SILENCE_RMS_THRESHOLD,
} from "../vox_clash_runner/audio/observer.js";
import {
  buildReceiverArgs,
  DEFAULT_MODERATOR_UID,
  type BroadcastConfig,
} from "../vox_clash_runner/audio/broadcaster.js";

// ---------------------------------------------------------------------------
// config.ts — arg builders (every capture/playback process uses these)
// ---------------------------------------------------------------------------

describe("audio config arg builders", () => {
  it("uses the canonical 16kHz mono s16le format", () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(CHANNELS).toBe(1);
    expect(FORMAT).toBe("s16le");
    expect(BYTES_PER_SAMPLE).toBe(2);
    expect(FORMAT_LABEL).toBe("16000hz_1ch_s16le");
  });

  it("parecArgs targets the given monitor device in raw mode", () => {
    const args = parecArgs("Sink_A_Out.monitor");
    expect(args).toContain("-d");
    expect(args).toContain("Sink_A_Out.monitor");
    expect(args).toContain("--format=s16le");
    expect(args).toContain("--rate=16000");
    expect(args).toContain("--channels=1");
    expect(args).toContain("--raw");
  });

  it("pacatArgs targets the given sink in raw mode", () => {
    const args = pacatArgs("Sink_B_In");
    expect(args).toContain("-d");
    expect(args).toContain("Sink_B_In");
    expect(args).toContain("--format=s16le");
    expect(args).toContain("--rate=16000");
    expect(args).toContain("--channels=1");
    expect(args).toContain("--raw");
  });

  it("SOX_RAW_ARGS describes the same raw format", () => {
    expect(SOX_RAW_ARGS).toBe("-r 16000 -e signed -b 16 -c 1");
  });
});

// ---------------------------------------------------------------------------
// observer.ts — loopback module-id parsing (the warm-pool leak fix)
// ---------------------------------------------------------------------------

describe("loopback module id parsing", () => {
  it("parses the id printed by pactl load-module", () => {
    expect(parseLoadedModuleId("536870913\n")).toBe(536870913);
    expect(parseLoadedModuleId("42")).toBe(42);
  });

  it("returns null for junk output", () => {
    expect(parseLoadedModuleId("")).toBeNull();
    expect(parseLoadedModuleId("Failure: Module initialization failed")).toBeNull();
    expect(parseLoadedModuleId("-3")).toBeNull();
  });

  it("extracts only module-loopback ids from pactl list short modules", () => {
    const listing = [
      "1\tmodule-null-sink\tsink_name=Sink_A_Out",
      "2\tmodule-null-sink\tsink_name=Sink_B_Out",
      "17\tmodule-loopback\tsource=Sink_A_Out.monitor sink=Sink_B_In latency_msec=20",
      "18\tmodule-loopback\tsource=Sink_B_Out.monitor sink=Sink_A_In latency_msec=20",
      "19\tmodule-native-protocol-unix\t",
    ].join("\n");
    expect(parseLoopbackModuleIds(listing)).toEqual([17, 18]);
  });

  it("returns empty for a listing with no loopbacks (clean warm-pool state)", () => {
    const listing = "1\tmodule-null-sink\tsink_name=Sink_A_Out\n2\tmodule-null-sink\t";
    expect(parseLoopbackModuleIds(listing)).toEqual([]);
    expect(parseLoopbackModuleIds("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// broadcaster.ts — receiver argv (the moderator→agents audio contract)
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<BroadcastConfig> = {}): BroadcastConfig {
  return {
    appId: "test-app",
    channelName: "clash-event-1",
    tokenA: "tA",
    tokenB: "tB",
    uidA: 100,
    uidB: 200,
    receiverToken: "tR",
    receiverUid: 300,
    ...overrides,
  };
}

describe("receiver args (moderator uid filter)", () => {
  it("passes the server-provided moderator uid to --filterUid", () => {
    const args = buildReceiverArgs(baseConfig({ moderatorUid: 500 }));
    const i = args.indexOf("--filterUid");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("500");
  });

  it("keeps the receiver uid and moderator filter distinct", () => {
    const args = buildReceiverArgs(baseConfig({ moderatorUid: 777 }));
    expect(args[args.indexOf("--userId") + 1]).toBe("300");
    expect(args[args.indexOf("--filterUid") + 1]).toBe("777");
  });

  it("falls back to DEFAULT_MODERATOR_UID (500) when the server omits it", () => {
    // Compatibility with servers that predate agora.moderatorUid.
    expect(DEFAULT_MODERATOR_UID).toBe(500);
    const args = buildReceiverArgs(baseConfig());
    expect(args[args.indexOf("--filterUid") + 1]).toBe("500");
  });

  it("carries the channel and audio format", () => {
    const args = buildReceiverArgs(baseConfig());
    expect(args[args.indexOf("--channelId") + 1]).toBe("clash-event-1");
    expect(args[args.indexOf("--sampleRate") + 1]).toBe("16000");
    expect(args[args.indexOf("--numOfChannels") + 1]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// observer.ts — audio-health math (RMS + talk time)
// ---------------------------------------------------------------------------

/** Build a raw s16le mono PCM buffer: sine at the given amplitude (0..1). */
function sinePcm(seconds: number, amplitude: number, freq = 440): Buffer {
  const samples = Math.floor(seconds * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amplitude * 32767);
    buf.writeInt16LE(v, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

describe("computePcmStats (audio health)", () => {
  it("silence → zero RMS, zero talk time", () => {
    const silence = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE); // 1s of zeros
    const stats = computePcmStats(silence);
    expect(stats.rms).toBe(0);
    expect(stats.activeRatio).toBe(0);
    expect(stats.activeSeconds).toBe(0);
    expect(stats.durationSeconds).toBeCloseTo(1, 3);
  });

  it("empty buffer → all-zero stats, no crash", () => {
    const stats = computePcmStats(Buffer.alloc(0));
    expect(stats.rms).toBe(0);
    expect(stats.durationSeconds).toBe(0);
  });

  it("a loud sine is fully active with RMS ≈ amplitude/√2", () => {
    const stats = computePcmStats(sinePcm(2, 0.5));
    expect(stats.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(stats.activeRatio).toBeCloseTo(1, 2);
    expect(stats.activeSeconds).toBeCloseTo(2, 1);
  });

  it("half speech / half silence → activeRatio ≈ 0.5", () => {
    const speech = sinePcm(1, 0.5);
    const silence = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE);
    const stats = computePcmStats(Buffer.concat([speech, silence]));
    expect(stats.activeRatio).toBeGreaterThan(0.4);
    expect(stats.activeRatio).toBeLessThan(0.6);
    expect(stats.activeSeconds).toBeCloseTo(1, 0);
  });

  it("sub-threshold noise counts as silence", () => {
    // Amplitude well below the silence RMS threshold.
    const quiet = sinePcm(1, SILENCE_RMS_THRESHOLD / 4);
    const stats = computePcmStats(quiet);
    expect(stats.activeRatio).toBe(0);
  });
});

describe("computeMetrics (per-agent audio health on the match record)", () => {
  it("carries each agent's RMS and talk time", () => {
    const statsA = computePcmStats(sinePcm(2, 0.5));
    const { metricsA, metricsB } = computeMetrics(statsA, null);
    expect(metricsA.audioRms).toBeCloseTo(0.3536, 2);
    expect(metricsA.talkTimeSeconds).toBeCloseTo(2, 0);
    // Missing capture → nulls, so a dead pipeline is distinguishable from silence.
    expect(metricsB.audioRms).toBeNull();
    expect(metricsB.talkTimeSeconds).toBeNull();
  });

  it("a silent agent reports zero talk time (detectable), not null", () => {
    const silentStats = computePcmStats(Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE * 5));
    const { metricsA } = computeMetrics(silentStats, silentStats);
    expect(metricsA.audioRms).toBe(0);
    expect(metricsA.talkTimeSeconds).toBe(0);
  });

  it("turn-level metrics remain null (known gap, documented in CLASH_DESIGN.md)", () => {
    const { metricsA } = computeMetrics(null, null);
    expect(metricsA.responseLatencyMedian).toBeNull();
    expect(metricsA.interruptLatencyMedian).toBeNull();
    expect(metricsA.turnCount).toBe(0);
  });
});
