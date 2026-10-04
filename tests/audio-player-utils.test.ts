import { describe, expect, it } from "vitest";
import { activeTranscriptIndex, buildWaveformPeaks, clampTime, formatAudioTime, MAX_TRANSCRIPT_SEGMENTS, MAX_TRANSCRIPT_TEXT, normalizeTranscript, timelineTicks, transcriptEndIndex, waveformCanvasSize } from "../client/src/components/audio-player/utils";
import { pcmWaveform } from "../client/src/components/audio-player/pcm-waveform";
import { findRecordingTranscript, parseRecordingTranscript, transcriptFromMetrics } from "../client/src/lib/recording-transcript";

function pcmFixture(bits = 16, codec = 1, channels = 2, extensible = false) {
  const values = [0, -0.5, 0.75, 0];
  const alignment = channels * bits / 8;
  const fmtSize = extensible ? 40 : 16;
  const dataOffset = 28 + fmtSize;
  const bytes = Buffer.alloc(dataOffset + values.length * alignment);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(fmtSize, 16);
  bytes.writeUInt16LE(extensible ? 0xfffe : codec, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(16000 * alignment, 28); bytes.writeUInt16LE(alignment, 32); bytes.writeUInt16LE(bits, 34);
  if (extensible) {
    bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(bits, 38); bytes.writeUInt32LE(codec, 44);
    bytes.set([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 48);
  }
  bytes.write("data", dataOffset - 8); bytes.writeUInt32LE(values.length * alignment, dataOffset - 4);
  for (let frame = 0; frame < values.length; frame++) for (let channel = 0; channel < channels; channel++) {
    const offset = dataOffset + frame * alignment + channel * bits / 8;
    const value = channel % 2 ? 0 : values[frame];
    if (codec === 3) { if (bits === 32) bytes.writeFloatLE(value, offset); else bytes.writeDoubleLE(value, offset); }
    else if (bits === 8) bytes.writeUInt8(Math.round(value * 128 + 128), offset);
    else bytes.writeIntLE(Math.round(value * 2 ** (bits - 1)), offset, bits / 8);
  }
  return bytes;
}
const arrayBuffer = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe("bounded PCM waveform extraction", () => {
  for (const [bits, codec] of [[8, 1], [16, 1], [24, 1], [32, 1], [32, 3], [64, 3]]) {
    it(`reads ${bits}-bit ${codec === 1 ? "integer" : "float"} samples without a browser decoder`, () => {
      const waveform = pcmWaveform(arrayBuffer(pcmFixture(bits, codec)));
      expect(waveform.duration).toBe(4 / 16000);
      expect(Array.from(waveform.channels[0])).toEqual([0, 0.5, 0.75, 0]);
      expect(Array.from(waveform.channels[1])).toEqual([0, 0, 0, 0]);
    });
  }
  it("supports extensible multichannel PCM WAVs", () => {
    expect(pcmWaveform(arrayBuffer(pcmFixture(24, 1, 6, true))).channels).toHaveLength(6);
  });
  it("rejects compressed and invalid formats before any sample allocation", () => {
    expect(() => pcmWaveform(arrayBuffer(Buffer.from("OggS compressed audio")))).toThrow("Unsupported waveform format");
    expect(() => pcmWaveform(new ArrayBuffer(0))).toThrow("Unsupported waveform format");
    const badData = pcmFixture(); badData.writeUInt32LE(0xffffffff, 40);
    expect(() => pcmWaveform(arrayBuffer(badData))).toThrow("Invalid WAV data");
    const tooManyChannels = pcmFixture(8, 1, 33);
    expect(() => pcmWaveform(arrayBuffer(tooManyChannels))).toThrow("Unsupported waveform format");
  });
  it("ignores non-finite float samples and clamps out-of-range peaks", () => {
    const bytes = pcmFixture(32, 3, 1);
    bytes.writeFloatLE(NaN, 44); bytes.writeFloatLE(Infinity, 48); bytes.writeFloatLE(-2, 52);
    expect(Array.from(pcmWaveform(arrayBuffer(bytes)).channels[0])).toEqual([0, 0, 1, 0]);
  });
});

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
  it("bounds canvas dimensions and the total 32-channel surface memory", () => {
    const size = waveformCanvasSize(1920 * 8, 84, 2);
    expect(size).toEqual({ width: 2048, height: 128 });
    expect(size.width * size.height * 4 * 2 * 32).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(waveformCanvasSize(390, 76, 1)).toEqual({ width: 390, height: 76 });
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
  it("does not attach a lone metric chunk or unidentified clock to a different recording", () => {
    const turn = { turn_start: 1, turn_end: 4, user_transcript: "hello", case_id: "RSP", chunk_id: "chunk_001" };
    const metrics = { response_metrics: { latency: { turn_level: [turn] } } };
    expect(transcriptFromMetrics(metrics, "vox-INT-chunk_002-abc/recording.wav")).toEqual([]);
    expect(transcriptFromMetrics(metrics, "vox-RSP-chunk_001-abc/recording.wav")).toHaveLength(1);
    expect(transcriptFromMetrics({ response_metrics: { latency: { turn_level: [{ turn_start: 1, turn_end: 4, user_transcript: "no chunk identity" }] } } }, "vox-RSP-chunk_001-abc/recording.wav")).toEqual([]);
  });
  it("filters invalid timing/text and orders valid segments", () => {
    expect(normalizeTranscript([{ start: 2, end: 4, text: " second " }, { start: -1, end: 2, text: "bad" }, { start: 1, end: 1, text: "empty" }, { start: 0, end: 1, text: "first" }, { start: NaN, end: 2, text: "bad" }])).toEqual([{ start: 0, end: 1, text: "first" }, { start: 2, end: 4, text: "second" }]);
  });
  it("bounds preview segment count and text without modifying the supplied transcript", () => {
    const original = Array.from({ length: MAX_TRANSCRIPT_SEGMENTS + 10 }, (_, index) => ({ start: index, end: index + 1, text: "a".repeat(MAX_TRANSCRIPT_TEXT + 10) }));
    const normalized = normalizeTranscript(original);
    expect(normalized).toHaveLength(MAX_TRANSCRIPT_SEGMENTS);
    expect(normalized[0].text).toHaveLength(MAX_TRANSCRIPT_TEXT + 3);
    expect(original[0].text).toHaveLength(MAX_TRANSCRIPT_TEXT + 10);
  });
  it("bounds parsed transcript objects while retaining a truncation indicator", () => {
    const source = [{ user_segments: Array.from({ length: MAX_TRANSCRIPT_SEGMENTS + 10 }, (_, index) => ({ start: index, end: index + 1, text: "speech" })) }];
    expect(parseRecordingTranscript(JSON.stringify(source))).toHaveLength(MAX_TRANSCRIPT_SEGMENTS + 1);
  });
  it("indexes active speech through overlap, gaps, and exact end boundaries", () => {
    const overlapping = normalizeTranscript([{ start: 0, end: 100, text: "long" }, { start: 1, end: 2, text: "short" }, { start: 3, end: 4, text: "later" }]);
    const ends = transcriptEndIndex(overlapping);
    expect(activeTranscriptIndex(overlapping, ends, 50)).toBe(0);
    expect(activeTranscriptIndex(overlapping, ends, 100)).toBe(-1);
    const separate = normalizeTranscript([{ start: 0, end: 2, text: "first" }, { start: 5, end: 6, text: "second" }]);
    expect(activeTranscriptIndex(separate, transcriptEndIndex(separate), 3)).toBe(-1);
    expect(activeTranscriptIndex(separate, transcriptEndIndex(separate), 5)).toBe(1);
    expect(activeTranscriptIndex([], [], 0)).toBe(-1);
  });
});
