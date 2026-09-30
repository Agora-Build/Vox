// A WAV file with a zero-filled data chunk; `extra` chunks go between fmt and data.
export function makeWav(opts: { channels: number; rate: number; bits: number; seconds: number; format?: number; extra?: Array<[string, number]> }): Uint8Array {
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
