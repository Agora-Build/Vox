import { describe, it, expect } from "vitest";
import { parseWavHeader, analyzeWavError, ANALYZE_MAX_BYTES, ANALYZE_MAX_SECONDS } from "../shared/wav";
import { makeWav } from "./fixtures/make-wav";

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
    expect(parseWavHeader(whole.slice(0, 64), whole.length)).toMatchObject({ channels: 2, durationSec: 10 });
  });

  it("trusts the file, not a streaming recorder's placeholder data size", () => {
    const wav = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 3 });
    const v = new DataView(wav.buffer);
    for (const placeholder of [0, 0xffffffff, 10 ** 9]) {
      v.setUint32(40, placeholder, true); // data chunk size
      // Given the whole file's size, the duration comes from the bytes that are there.
      expect(parseWavHeader(wav.slice(0, 64), wav.length)).toMatchObject({ durationSec: 3 });
    }
  });

  it("reads the subformat of an extensible WAV", () => {
    const mk = (sub: number) => {
      // fmt chunk of 40 bytes: format 0xFFFE, then cbSize 22, valid bits, mask, subformat GUID.
      const wav = makeWav({ channels: 2, rate: 16000, bits: 16, seconds: 1, format: 0xfffe, fmtExtra: 24 });
      new DataView(wav.buffer).setUint16(12 + 8 + 24, sub, true);
      return parseWavHeader(wav);
    };
    expect(mk(1)).toMatchObject({ format: 1 });       // PCM
    expect(analyzeWavError(mk(1), 100)).toBeNull();
    expect(analyzeWavError(mk(0x55), 100)).toMatch(/PCM/); // MP3 in an extensible wrapper
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
