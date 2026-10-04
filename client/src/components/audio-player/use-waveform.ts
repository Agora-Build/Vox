import { useEffect, useState } from "react";
import type { AudioWaveform } from "./types";
import { hasWaveHeader, MAX_WAVEFORM_BYTES } from "./pcm-waveform";
import { WaveformByteBuffer } from "./waveform-buffer";

export function useWaveform(src: string, enabled: boolean) {
  const [state, setState] = useState<{ src: string; data?: AudioWaveform; loading: boolean; error?: string }>({ src, loading: true });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let worker: Worker | undefined;
    setState({ src, loading: true });
    const load = async () => {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error("Recording unavailable");
      const encoding = response.headers.get("Content-Encoding");
      // fetch streams decoded bytes; compressed Content-Length is not their size.
      const expectedBytes = encoding && encoding !== "identity" ? 0 : Number(response.headers.get("Content-Length"));
      if (Number(response.headers.get("Content-Length")) > MAX_WAVEFORM_BYTES) {
        await response.body?.cancel();
        throw new Error("Recording too large");
      }
      // Read incrementally so a missing Content-Length cannot bypass the memory cap.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Streaming is unavailable");
      const header = new Uint8Array(12);
      let headerSize = 0;
      let bytes: WaveformByteBuffer | undefined;
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_WAVEFORM_BYTES) {
          await reader.cancel();
          throw new Error("Recording too large");
        }
        if (!bytes) {
          const part = value.subarray(0, 12 - headerSize);
          header.set(part, headerSize); headerSize += part.length;
          if (headerSize < 12) continue;
          if (!hasWaveHeader(header.buffer)) { await reader.cancel(); throw new Error("Unsupported waveform format"); }
          bytes = new WaveformByteBuffer(expectedBytes);
          bytes.append(header); bytes.append(value.subarray(part.length));
        } else bytes.append(value);
      }
      if (!bytes) throw new Error("Unsupported waveform format");
      const buffer = bytes.finish();
      if (controller.signal.aborted) return;
      worker = new Worker(new URL("./waveform.worker.ts", import.meta.url), { type: "module" });
      const data = await new Promise<AudioWaveform>((resolve, reject) => {
        const aborted = () => reject(new DOMException("Waveform cancelled", "AbortError"));
        controller.signal.addEventListener("abort", aborted, { once: true });
        worker!.onmessage = (event: MessageEvent<{ data?: AudioWaveform; error?: string }>) => {
          controller.signal.removeEventListener("abort", aborted);
          if (event.data.data) resolve(event.data.data);
          else reject(new Error(event.data.error ?? "Waveform processing failed"));
        };
        worker!.onerror = () => {
          controller.signal.removeEventListener("abort", aborted);
          reject(new Error("Waveform processing failed"));
        };
        worker!.postMessage({ bytes: buffer }, [buffer]);
      });
      if (!controller.signal.aborted) setState({ src, data, loading: false });
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ src, loading: false, error: error instanceof Error && error.message === "Recording too large"
        ? "Waveform previews are limited to recordings under 64 MB. Playback still works."
        : error instanceof Error && error.message === "Unsupported waveform format"
        ? "Waveform previews support PCM WAV recordings with up to 32 channels. This format can still be played."
        : error instanceof Error && error.message === "Streaming buffer unavailable"
        ? "Waveform previews require a Content-Length header on this browser. Playback is still available."
        : "Waveform unavailable. Playback still works; the format or storage permissions may not allow waveform decoding." });
    }).finally(() => {
      controller.abort();
      worker?.terminate();
    });
    return () => {
      controller.abort();
      worker?.terminate();
    };
  }, [src, enabled]);
  return state.src === src ? state : { src, loading: true };
}
