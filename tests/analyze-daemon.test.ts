import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runAnalyzeUpload, capabilitiesFor, writeLimited } from "../vox_eval_agentd/analyze-upload";
import { Readable } from "stream";
import { createHash } from "crypto";
import { makeWav } from "./fixtures/make-wav";

// Tools → Analyze on the eval agent (design 2026-09-30): download the upload,
// check it, stage it as the phone path stages its mix, run aeval analyze,
// report its metrics. Real files, fake network and aeval.

const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "analyze-daemon-test-"));
// Serves `bytes`, and reports them as what was uploaded (as Core does).
const writer = (bytes: Uint8Array) => async (dest: string) => {
  fs.writeFileSync(dest, bytes);
  return { sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};

describe("runAnalyzeUpload", () => {
  it("stages the recording where aeval analyze expects it, then reports the metrics", async () => {
    const wav = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 });
    const analyzed: string[] = [];
    let staged: Buffer | null = null;
    const dir = workDir();
    const out = await runAnalyzeUpload({
      workDir: dir,
      download: writer(wav),
      // What aeval sees while it runs.
      analyze: async (dir) => { analyzed.push(dir); staged = fs.readFileSync(path.join(dir, "recordings", "recording.wav")); },
      parseMetrics: () => ({ responseLatencyMedian: 850 }),
    });
    expect(analyzed).toEqual([dir]);
    expect(staged).toEqual(Buffer.from(wav));
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

  it("nothing of an analysis stays on the agent or leaves as an artifact", async () => {
    // The result (metrics, turns, transcripts) is reported to Core; the
    // recording and aeval's output are the uploader's and go nowhere else.
    const dir = workDir();
    await runAnalyzeUpload({
      workDir: dir,
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async (d) => { fs.mkdirSync(path.join(d, "analysis"), { recursive: true }); fs.writeFileSync(path.join(d, "analysis", "turns.json"), "[]"); },
      parseMetrics: () => ({}),
    });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a failed analysis leaves nothing behind on the agent", async () => {
    const dir = workDir();
    await expect(runAnalyzeUpload({
      workDir: dir,
      download: writer(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 })),
      analyze: async () => { throw new Error("aeval analyze exited 1"); },
      parseMetrics: () => ({}),
    })).rejects.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a file that isn't the one uploaded (replaced in the uploader's bucket)", async () => {
    // Core tells the agent the size and SHA-256 it recorded at upload.
    const uploaded = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 });
    const expected = { sizeBytes: uploaded.length, sha256: createHash("sha256").update(uploaded).digest("hex") };
    const serving = (bytes: Uint8Array) => async (dest: string) => { fs.writeFileSync(dest, bytes); return expected; };
    let ran = false;
    const run = (bytes: Uint8Array) => runAnalyzeUpload({ workDir: workDir(), download: serving(bytes), analyze: async () => { ran = true; }, parseMetrics: () => ({}) });
    await expect(run(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 2 }))).rejects.toThrow("isn't the recording that was uploaded");
    const tampered = new Uint8Array(uploaded); tampered[100] ^= 0xff; // same size, other bytes
    await expect(run(tampered)).rejects.toThrow("isn't the recording that was uploaded");
    expect(ran).toBe(false);
    await run(uploaded);
    expect(ran).toBe(true);
  });

  it("writeLimited stops a download that runs past the uploaded size", async () => {
    const dest = path.join(workDir(), "x.wav");
    await writeLimited(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), dest, 1000).then(
      () => { throw new Error("should have stopped"); },
      (e: Error) => expect(e.message).toMatch("larger than the uploaded recording"),
    );
    await writeLimited(Readable.from([Buffer.alloc(600), Buffer.alloc(400)]), dest, 1000);
    expect(fs.statSync(dest).size).toBe(1000);
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
