import type { AudioWaveform } from "./types";

export const MAX_WAVEFORM_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_CHANNELS = 32;

export function hasWaveHeader(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes);
  return view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645;
}

export function hasEncodedAudioHeader(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes);
  const tag = view.getUint32(0, false);
  return tag === 0x1a45dfa3 || tag === 0x4f676753 || tag === 0x664c6143
    || view.getUint32(4, false) === 0x66747970 || tag >>> 8 === 0x494433
    || (view.getUint16(0, false) & 0xffe0) === 0xffe0;
}

// Read PCM directly in the worker: compressed files never reach an unbounded decoder.
export function pcmWaveform(bytes: ArrayBuffer): AudioWaveform {
  if (bytes.byteLength > MAX_WAVEFORM_BYTES) throw new Error("Recording too large");
  const view = new DataView(bytes);
  const tag = (offset: number) => view.getUint32(offset, false);
  if (!hasWaveHeader(bytes)) throw new Error("Unsupported waveform format");
  let format: { codec: number; channels: number; rate: number; alignment: number; bits: number } | undefined;
  let data: { offset: number; size: number } | undefined;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (size > bytes.byteLength - start) throw new Error("Invalid WAV data");
    if (tag(offset) === 0x666d7420) {
      if (format || size < 16) throw new Error("Invalid WAV format");
      let codec = view.getUint16(start, true);
      if (codec === 0xfffe) {
        if (size < 40 || view.getUint32(start + 28, true) !== 0x00100000
          || view.getUint32(start + 32, false) !== 0x800000aa || view.getUint32(start + 36, false) !== 0x00389b71) throw new Error("Unsupported waveform format");
        codec = view.getUint32(start + 24, true);
      }
      format = { codec, channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), alignment: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    } else if (tag(offset) === 0x64617461) {
      if (data) throw new Error("Unsupported waveform format");
      data = { offset: start, size };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error("Invalid WAV data");
  const { codec, channels, rate, alignment, bits } = format;
  const supported = codec === 1 ? [8, 16, 24, 32].includes(bits) : codec === 3 && [32, 64].includes(bits);
  if (!supported || channels < 1 || channels > MAX_AUDIO_CHANNELS) throw new Error("Unsupported waveform format");
  if (!rate || alignment !== channels * bits / 8 || !data.size || data.size % alignment) throw new Error("Invalid WAV data");
  const frames = data.size / alignment;
  const bins = Math.min(4096, frames);
  const peaks = Array.from({ length: channels }, () => new Float32Array(bins));
  const sample = (offset: number) => {
    if (codec === 3) return bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    if (bits === 8) return (view.getUint8(offset) - 128) / 128;
    if (bits === 16) return view.getInt16(offset, true) / 32768;
    if (bits === 24) return (view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16) / 8388608;
    return view.getInt32(offset, true) / 2147483648;
  };
  for (let bin = 0; bin < bins; bin++) {
    const end = Math.floor((bin + 1) * frames / bins);
    for (let frame = Math.floor(bin * frames / bins); frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const value = Math.abs(sample(data.offset + frame * alignment + channel * bits / 8));
        if (Number.isFinite(value)) peaks[channel][bin] = Math.max(peaks[channel][bin], Math.min(1, value));
      }
    }
  }
  return { duration: frames / rate, sampleRate: rate, channels: peaks };
}
