import { describe, it, expect } from "vitest";
import { parseWavHeader, analyzeWavError, ANALYZE_MAX_BYTES, ANALYZE_MAX_SECONDS } from "../shared/wav";

// A WAV file with a zero-filled data chunk; `extra` chunks go between fmt and data.
function makeWav(opts: { channels: number; rate: number; bits: number; seconds: number; format?: number; extra?: Array<[string, number]> }): Uint8Array {
  const { channels, rate, bits, seconds, format = 1, extra = [] } = opts;
  const blockAlign = channels * (bits / 8);
  const dataSize = Math.round(seconds * rate) * blockAlign;
  const extraSize = extra.reduce((n, [, size]) => n + 8 + size + (size % 2), 0);
  const buf = new Uint8Array(12 + 24 + extraSize + 8 + dataSize);
  const v = new DataView(buf.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < 4; i++) buf[off + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, buf.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, format, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, bits, true);
  let off = 36;
  for (const [id, size] of extra) { tag(off, id); v.setUint32(off + 4, size, true); off += 8 + size + (size % 2); }
  tag(off, "data"); v.setUint32(off + 4, dataSize, true);
  return buf;
}

describe("parseWavHeader", () => {
  it("reads a stereo 16 kHz 16-bit file", () => {
    expect(parseWavHeader(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 2 })))
      .toEqual({ channels: 2, sampleRate: 16000, bitsPerSample: 16, format: 1, durationSec: 2 });
  });

  it("skips chunks it doesn't know, odd-sized ones included", () => {
    const info = parseWavHeader(makeWav({ channels: 2, rate: 48000, bits: 16, seconds: 1, extra: [["LIST", 27], ["junk", 4]] }));
    expect(info).toMatchObject({ channels: 2, sampleRate: 48000, durationSec: 1 });
  });

  it("needs only the header: the data itself may be cut off", () => {
    const whole = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 10 });
    expect(parseWavHeader(whole.slice(0, 64))).toMatchObject({ channels: 2, durationSec: 10 });
  });

  it("refuses what isn't a WAV file", () => {
    expect(parseWavHeader(new TextEncoder().encode("ID3\u0003 not a wav file at all, just text"))).toHaveProperty("error");
    const rifx = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 });
    rifx[3] = "X".charCodeAt(0);
    expect(parseWavHeader(rifx)).toHaveProperty("error");
  });

  it("refuses a header that ends before the data chunk", () => {
    expect(parseWavHeader(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1 }).slice(0, 30))).toHaveProperty("error");
  });
});

describe("analyzeWavError", () => {
  const ok = (o: Partial<Parameters<typeof makeWav>[0]> = {}) =>
    parseWavHeader(makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 5, ...o }));

  it("accepts a stereo PCM recording within the limits", () => {
    expect(analyzeWavError(ok(), 1000)).toBeNull();
  });

  it("refuses mono, saying which channel is which", () => {
    expect(analyzeWavError(ok({ channels: 1 }), 1000)).toBe("The recording must be stereo: left channel = user, right channel = agent.");
  });

  it("refuses compressed audio", () => {
    expect(analyzeWavError(ok({ format: 85 }), 1000)).toMatch(/PCM/);
  });

  it("refuses a recording that is too long or a file that is too large", () => {
    expect(analyzeWavError(ok({ seconds: ANALYZE_MAX_SECONDS + 1, rate: 8000, bits: 8 }), 1000)).toMatch(/30 minutes/);
    expect(analyzeWavError(ok(), ANALYZE_MAX_BYTES + 1)).toMatch(/100 MB/);
  });

  it("passes a parse error through", () => {
    expect(analyzeWavError({ error: "Not a WAV file." }, 10)).toBe("Not a WAV file.");
  });
});
