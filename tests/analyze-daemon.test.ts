import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runAnalyzeUpload, capabilitiesFor } from "../vox_eval_agentd/analyze-upload";
import { makeWav } from "./fixtures/make-wav";

// Tools → Analyze on the eval agent (design 2026-09-30): download the upload,
// check it, stage it as the phone path stages its mix, run aeval analyze,
// report its metrics. Real files, fake network and aeval.

const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "analyze-daemon-test-"));
const writer = (bytes: Uint8Array) => async (dest: string) => { fs.writeFileSync(dest, bytes); };

describe("runAnalyzeUpload", () => {
  it("stages the recording where aeval analyze expects it, then reports the metrics", async () => {
    const wav = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 });
    const analyzed: string[] = [];
    const out = await runAnalyzeUpload({
      workDir: workDir(),
      download: writer(wav),
      analyze: async (dir) => { analyzed.push(dir); },
      parseMetrics: () => ({ responseLatencyMedian: 850 }),
    });
    expect(analyzed).toEqual([out.sessionDir]);
    expect(fs.readFileSync(path.join(out.sessionDir, "recordings", "recording.wav"))).toEqual(Buffer.from(wav));
    expect(out.result).toMatchObject({ responseLatencyMedian: 850 });
  });

  it("joins aeval's transcripts onto the turns, as the phone path does", async () => {
    const out = await runAnalyzeUpload({
      workDir: workDir(),
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async (dir) => {
        fs.mkdirSync(path.join(dir, "analysis"), { recursive: true });
        // aeval writes bare Infinity tokens; the parser copes.
        fs.writeFileSync(path.join(dir, "analysis", "turns.json"),
          '[{"index":0,"start":0.5,"end":4.2,"turn_boundary":Infinity,"user_segments":[{"text":"what time is it"}],"agent_segments":[{"text":"it is noon"}]}]');
      },
      parseMetrics: () => ({ rawData: { response_metrics: { latency: { turn_level: [{ turn_index: 0, latency_ms: 900 }] } } } }),
    });
    const turn = (out.result.rawData as any).response_metrics.latency.turn_level[0];
    expect(turn).toMatchObject({ turn_start: 0.5, turn_end: 4.2, user_transcript: "what time is it", agent_transcript: "it is noon" });
  });

  it("reports what a recording can't measure as not measured, not as a default", async () => {
    const out = await runAnalyzeUpload({
      workDir: workDir(),
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async () => {},
      parseMetrics: () => ({ responseLatencyMedian: 900, networkResilience: 85, naturalness: 3.5, noiseReduction: 90 }),
    });
    expect(out.result).toMatchObject({ responseLatencyMedian: 900, networkResilience: null, naturalness: null, noiseReduction: null });
  });

  it("refuses a mono file before running aeval", async () => {
    let ran = false;
    await expect(runAnalyzeUpload({
      workDir: workDir(),
      download: writer(makeWav({ channels: 1, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async () => { ran = true; },
      parseMetrics: () => ({}),
    })).rejects.toThrow("must be stereo");
    expect(ran).toBe(false);
  });

  it("fails when aeval produced no metrics (no partial results)", async () => {
    await expect(runAnalyzeUpload({
      workDir: workDir(),
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async () => {},
      parseMetrics: () => null,
    })).rejects.toThrow("analysis produced no usable metrics");
  });

  it("passes a failed aeval run through as the job's error", async () => {
    await expect(runAnalyzeUpload({
      workDir: workDir(),
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async () => { throw new Error("aeval analyze exited 1: boom"); },
      parseMetrics: () => ({}),
    })).rejects.toThrow("aeval analyze exited 1: boom");
  });
});

describe("capabilitiesFor", () => {
  it("reports analyze when aeval runs, phone when DialF is up", () => {
    expect(capabilitiesFor({ dialf: false, aeval: true })).toEqual(["analyze"]);
    expect(capabilitiesFor({ dialf: true, aeval: true })).toEqual(["phone", "analyze"]);
    expect(capabilitiesFor({ dialf: true, aeval: false })).toEqual(["phone"]);
    expect(capabilitiesFor({ dialf: false, aeval: false })).toEqual([]);
  });
});
