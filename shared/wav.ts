// WAV header check for Tools → Analyze (design 2026-09-30). Shared by the
// browser (a quick message before upload), Core (the check that counts) and
// the eval agent (before it runs aeval). Dependency-free: the client imports it.

export type WavInfo = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  // 1 = PCM, 3 = IEEE float (an extensible file's subformat); else compressed.
  format: number;
  durationSec: number;
};

export const ANALYZE_MAX_BYTES = 100 * 1024 * 1024;
export const ANALYZE_MAX_SECONDS = 30 * 60;
// Where the audio (the data chunk) must start. The browser, Core and the
// agent all read just this much to check a file, so they agree on it.
export const ANALYZE_HEADER_BYTES = 1 << 20;

const PCM_FORMATS = new Set([1, 3]);

/**
 * Read a WAV header. Only the bytes up to the start of the data chunk are
 * needed, so a caller may pass just the first part of a large file, plus the
 * whole file's size (`totalBytes`): streaming recorders leave the data size as
 * a placeholder (0 or 0xFFFFFFFF), so the audio's length comes from the bytes
 * actually there whenever the declared size doesn't fit the file.
 */
export function parseWavHeader(bytes: Uint8Array, totalBytes: number = bytes.length): WavInfo | { error: string } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return { error: "Not a WAV file." };

  let fmt: Omit<WavInfo, "durationSec"> & { byteRate: number; blockAlign: number } | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      if (size < 16) return { error: "The WAV file's format chunk is too short." };
      if (off + 8 + 16 > bytes.length) break;
      const format = v.getUint16(off + 8, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of its
      // subformat GUID, 24 bytes into the chunk.
      const extensible = format === 0xfffe && size >= 40 && off + 8 + 26 <= bytes.length;
      fmt = {
        format: extensible ? v.getUint16(off + 8 + 24, true) : format,
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        byteRate: v.getUint32(off + 16, true),
        blockAlign: v.getUint16(off + 20, true),
        bitsPerSample: v.getUint16(off + 22, true),
      };
      // The duration comes from these, so they must agree with each other.
      const { channels, sampleRate, byteRate, blockAlign, bitsPerSample } = fmt;
      if (![8, 16, 24, 32].includes(bitsPerSample) || channels === 0 || sampleRate === 0
        || blockAlign !== channels * (bitsPerSample / 8) || byteRate !== sampleRate * blockAlign) {
        return { error: "The WAV file's format chunk is inconsistent." };
      }
    } else if (id === "data") {
      if (!fmt) return { error: "The WAV file has no format chunk before its audio." };
      if (fmt.byteRate === 0) return { error: "The WAV file's format chunk is invalid." };
      const { byteRate, blockAlign: _blockAlign, ...info } = fmt;
      const available = Math.max(0, totalBytes - (off + 8));
      const dataBytes = size === 0 || size > available ? available : size;
      return { ...info, durationSec: dataBytes / byteRate };
    }
    off += 8 + size + (size % 2); // chunks are padded to an even length
  }
  return bytes.length < totalBytes
    ? { error: "The WAV file's audio must start within its first 1 MB (there's too much metadata before it)." }
    : { error: "The WAV header is incomplete or has no audio." };
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
