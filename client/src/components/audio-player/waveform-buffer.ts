import { MAX_WAVEFORM_BYTES } from "./pcm-waveform";

type ResizableBuffer = ArrayBuffer & { resize?: (size: number) => void };

export class WaveformByteBuffer {
  private buffer: ResizableBuffer;
  private length = 0;
  private readonly grows: boolean;

  constructor(expectedBytes: number) {
    if (expectedBytes > MAX_WAVEFORM_BYTES) throw new Error("Recording too large");
    const fixed = Number.isSafeInteger(expectedBytes) && expectedBytes > 0;
    this.grows = !fixed;
    // A resizable buffer grows without retaining every downloaded chunk.
    this.buffer = fixed ? new ArrayBuffer(expectedBytes)
      : Reflect.construct(ArrayBuffer, [0, { maxByteLength: MAX_WAVEFORM_BYTES }]) as ResizableBuffer;
    if (!fixed && typeof this.buffer.resize !== "function") throw new Error("Streaming buffer unavailable");
  }

  append(chunk: Uint8Array) {
    const next = this.length + chunk.byteLength;
    if (next > MAX_WAVEFORM_BYTES) throw new Error("Recording too large");
    if (next > this.buffer.byteLength) {
      if (!this.grows || !this.buffer.resize) throw new Error("Recording length changed");
      this.buffer.resize(next);
    }
    new Uint8Array(this.buffer).set(chunk, this.length);
    this.length = next;
  }

  finish() {
    if (this.length !== this.buffer.byteLength) throw new Error("Recording length changed");
    return this.buffer;
  }
}
