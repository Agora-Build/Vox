import { describe, expect, it } from "vitest";
import { buildWaveformPeaks, clampTime, formatAudioTime, normalizeTranscript, timelineTicks } from "../client/src/components/audio-player/utils";
import { findRecordingTranscript, parseRecordingTranscript, transcriptFromMetrics } from "../client/src/lib/recording-transcript";

describe("audio timeline", () => {
  it("formats fractional and hour-long positions without floating-point drift", () => {
    expect(formatAudioTime(36.68, true)).toBe("00:36.68");
    expect(formatAudioTime(3661.05, true)).toBe("1:01:01.05");
    expect(formatAudioTime(Infinity, true)).toBe("00:00.00");
    expect(formatAudioTime(-10)).toBe("00:00");
  });
  it("clamps seeking to a finite recording duration", () => {
    expect(clampTime(-2, 10)).toBe(0);
    expect(clampTime(20, 10)).toBe(10);
    expect(clampTime(3, NaN)).toBe(0);
    expect(clampTime(Infinity, 10)).toBe(0);
  });
  it("builds bounded time ticks for normal and zoomed views", () => {
    expect(timelineTicks(42)).toEqual([0, 10, 20, 30, 40]);
    expect(timelineTicks(42, 4).length).toBeGreaterThan(timelineTicks(42).length);
    expect(timelineTicks(0)).toEqual([]);
    expect(timelineTicks(Infinity)).toEqual([]);
  });
});

describe("real waveform peaks", () => {
  it("covers every sample, including negative and trailing peaks", () => {
    expect([...buildWaveformPeaks(new Float32Array([0, -0.8, 0.4, 0.2, 1]), 2)]).toEqual([expect.closeTo(0.8), 1]);
  });
  it("does not invent signal for silence and handles empty/invalid samples", () => {
    expect([...buildWaveformPeaks(new Float32Array(4), 2)]).toEqual([0, 0]);
    expect(buildWaveformPeaks(new Float32Array())).toHaveLength(0);
    expect([...buildWaveformPeaks(new Float32Array([NaN, Infinity, -2]), 1)]).toEqual([1]);
  });
  it("bounds long channels independently", () => {
    expect(buildWaveformPeaks(new Float32Array(10000))).toHaveLength(4096);
    expect(buildWaveformPeaks(new Float32Array(10), NaN)).toHaveLength(10);
  });
});

describe("recording transcripts", () => {
  const file = (name: string) => ({ name, url: `https://storage.example/${name}`, size: 100, contentType: "application/json" });
  it("matches only the recording's chunk, not another chunk's clock", () => {
    const files = [file("vox-RSP-chunk_001-abc/analysis/turns.json"), file("vox-RSP-chunk_002-def/analysis/turns.json")];
    expect(findRecordingTranscript("vox-RSP-chunk_002-def/recording.wav", files)).toEqual(files[1]);
    expect(findRecordingTranscript("vox-RSP-chunk_003-xyz/recording.wav", files)).toBeUndefined();
  });
  it("accepts single-run layout, prefers precise folders and refuses ambiguous matches", () => {
    expect(findRecordingTranscript("recordings/stereo.wav", [file("analysis/turns.json")])?.name).toBe("analysis/turns.json");
    expect(findRecordingTranscript("chunk/recording.wav", [file("analysis/turns.json"), file("chunk/analysis/turns.json")])?.name).toBe("chunk/analysis/turns.json");
    expect(findRecordingTranscript("recording.wav", [file("turns.json"), file("analysis/turns.json")])).toBeUndefined();
  });
  it("reads per-speaker speech timestamps without corrupting transcript strings", () => {
    const result = parseRecordingTranscript('[{"start":0,"x":Infinity,"user_segments":[{"start":1,"end":2,"text":"score: NaN, not Infinity"}],"agent_segments":[{"start":3,"end":4,"text":"Hello"}]}]');
    expect(result).toEqual([
      { start: 1, end: 2, text: "score: NaN, not Infinity", speaker: "User", channel: 0 },
      { start: 3, end: 4, text: "Hello", speaker: "Agent", channel: 1 },
    ]);
    expect(() => parseRecordingTranscript("{}")).toThrow();
  });
  it("uses turn-level fallback only for an unambiguous recording and deduplicates metric families", () => {
    const turn = { turn_start: 1, turn_end: 4, user_transcript: "hello", agent_transcript: "hi" };
    const metrics = { response_metrics: { latency: { turn_level: [turn] } }, interruption_metrics: { latency: { turn_level: [turn] } } };
    expect(transcriptFromMetrics(metrics, "recording.wav")).toHaveLength(2);
    const multiple = { response_metrics: { latency: { turn_level: [{ ...turn, case_id: "RSP", chunk_id: "chunk_001" }, { ...turn, case_id: "INT", chunk_id: "chunk_002" }] } } };
    expect(transcriptFromMetrics(multiple, "recording.wav")).toEqual([]);
    expect(transcriptFromMetrics(multiple, "vox-INT-chunk_002-abc/recording.wav")).toHaveLength(2);
  });
  it("filters invalid timing/text and orders valid segments", () => {
    expect(normalizeTranscript([{ start: 2, end: 4, text: " second " }, { start: -1, end: 2, text: "bad" }, { start: 1, end: 1, text: "empty" }, { start: 0, end: 1, text: "first" }, { start: NaN, end: 2, text: "bad" }])).toEqual([{ start: 0, end: 1, text: "first" }, { start: 2, end: 4, text: "second" }]);
  });
});
