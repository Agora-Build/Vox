import { describe, expect, it, vi } from "vitest";
import { WaveformPeakAccumulator, MAX_DECODED_FRAME_FRAMES, MAX_PREVIEW_SECONDS } from "../client/src/components/audio-player/encoded-waveform";
import { hasEncodedAudioHeader } from "../client/src/components/audio-player/pcm-waveform";

function sample(planes: number[][], timestamp = 0) {
  return { numberOfFrames: planes[0].length, numberOfChannels: planes.length, sampleRate: 8000, timestamp,
    copyTo: vi.fn((destination: Float32Array, options: { planeIndex: number }) => destination.set(planes[options.planeIndex])),
  };
}

describe("frame-by-frame encoded waveform accumulation", () => {
  it("preserves separate channels and aligns frame timestamps to the recording clock", () => {
    const peaks = new WaveformPeakAccumulator(1, 2);
    const frame = sample([[0.75, -0.5, NaN, 2], [0, 0, 0, 0]], 500000);
    peaks.add(frame, 0, 2);
    expect(peaks.channels.map((channel) => channel.length)).toEqual([4096, 4096]);
    expect(peaks.channels[0][2048]).toBe(0.75);
    expect(Math.max(...peaks.channels[0])).toBe(1);
    expect(Math.max(...peaks.channels[1])).toBe(0);
    expect(frame.copyTo.mock.calls[0][0]).toBe(frame.copyTo.mock.calls[1][0]);
  });
  it("places distinct audio tracks in separate output channels", () => {
    const peaks = new WaveformPeakAccumulator(1, 3);
    peaks.add(sample([[0.3]]), 0, 1);
    peaks.add(sample([[0.5], [0.8]]), 1, 2);
    expect(peaks.channels.map((channel) => channel[0])).toEqual([expect.closeTo(0.3), 0.5, expect.closeTo(0.8)]);
  });
  it("does not invent signal from preroll or samples beyond the recording", () => {
    const peaks = new WaveformPeakAccumulator(1, 1);
    peaks.add(sample([[1]], -1_000_000), 0, 1);
    peaks.add(sample([[1]], 2_000_000), 0, 1);
    expect(peaks.channels[0].every((value) => value === 0)).toBe(true);
  });
  it("rejects oversized frames before copying decoded sample planes", () => {
    const peaks = new WaveformPeakAccumulator(1, 1);
    const frame = { ...sample([[1]]), numberOfFrames: MAX_DECODED_FRAME_FRAMES + 1 };
    expect(() => peaks.add(frame, 0, 1)).toThrow("Waveform processing limit");
    expect(frame.copyTo).not.toHaveBeenCalled();
    expect(() => peaks.add(sample([[1], [1]]), 0, 1)).toThrow();
    expect(() => peaks.add({ ...sample([[1]]), sampleRate: NaN }, 0, 1)).toThrow();
  });
  it("caps duration and channel count before allocating preview peaks", () => {
    for (const duration of [0, NaN, Infinity, MAX_PREVIEW_SECONDS + 1]) expect(() => new WaveformPeakAccumulator(duration, 2)).toThrow();
    for (const channels of [0, 33, 1.5]) expect(() => new WaveformPeakAccumulator(1, channels)).toThrow();
  });
});

describe("encoded audio header detection", () => {
  it.each(["1a45dfa30000000000000000", "4f6767530000000000000000", "664c61430000000000000000", "000000006674797000000000", "494433000000000000000000", "fff100000000000000000000"])("recognizes %s", (hex) => {
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    expect(hasEncodedAudioHeader(bytes.buffer)).toBe(true);
  });
  it("rejects truncated and unrelated headers", () => {
    expect(hasEncodedAudioHeader(new ArrayBuffer(4))).toBe(false);
    expect(hasEncodedAudioHeader(new ArrayBuffer(12))).toBe(false);
  });
});
