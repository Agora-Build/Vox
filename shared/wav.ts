// WAV header check for Tools → Analyze (design 2026-09-30). Shared by the
// browser (a quick message before upload), Core (the check that counts) and
// the eval agent (before it runs aeval). Dependency-free: the client imports it.

export type WavInfo = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  // 1 = PCM, 3 = IEEE float, 0xFFFE = extensible; anything else is compressed.
  format: number;
  durationSec: number;
};

export const ANALYZE_MAX_BYTES = 100 * 1024 * 1024;
export const ANALYZE_MAX_SECONDS = 30 * 60;

const PCM_FORMATS = new Set([1, 3, 0xfffe]);

/**
 * Read a WAV header. Only the bytes up to the start of the data chunk are
 * needed, so a caller may pass just the first part of a large file.
 */
export function parseWavHeader(bytes: Uint8Array): WavInfo | { error: string } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return { error: "Not a WAV file." };

  let fmt: Omit<WavInfo, "durationSec"> & { byteRate: number } | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      if (off + 8 + 16 > bytes.length) break;
      fmt = {
        format: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        byteRate: v.getUint32(off + 16, true),
        bitsPerSample: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      if (!fmt) return { error: "The WAV file has no format chunk before its audio." };
      if (fmt.byteRate === 0) return { error: "The WAV file's format chunk is invalid." };
      const { byteRate, ...info } = fmt;
      return { ...info, durationSec: size / byteRate };
    }
    off += 8 + size + (size % 2); // chunks are padded to an even length
  }
  return { error: "The WAV header is incomplete or has no audio." };
}

/** Why a recording can't be analyzed, or null when it can. */
export function analyzeWavError(info: WavInfo | { error: string }, sizeBytes: number): string | null {
  if ("error" in info) return info.error;
  if (sizeBytes > ANALYZE_MAX_BYTES) return "The file is larger than 100 MB.";
  if (!PCM_FORMATS.has(info.format)) return "The recording must be uncompressed PCM WAV.";
  if (info.channels !== 2) return "The recording must be stereo: left channel = user, right channel = agent.";
  if (info.durationSec > ANALYZE_MAX_SECONDS) return "The recording is longer than 30 minutes.";
  if (info.durationSec <= 0) return "The recording is empty.";
  return null;
}
