import { useEffect, useState } from "react";
import type { AudioWaveform } from "./types";
import { hasEncodedAudioHeader, hasWaveHeader, MAX_WAVEFORM_BYTES } from "./pcm-waveform";
import { WaveformByteBuffer } from "./waveform-buffer";
import { fetchPreview } from "../../lib/preview-fetch";

export function useWaveform(src: string, enabled: boolean) {
  const [state, setState] = useState<{ src: string; data?: AudioWaveform; loading: boolean; error?: string }>({ src, loading: true });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let worker: Worker | undefined;
    let processingTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ src, loading: true });
    const load = async () => {
      const response = await fetchPreview(src, controller.signal);
      if (!response.ok) throw new Error(response.status === 413 ? "Recording too large" : "Recording unavailable");
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
          if (!hasWaveHeader(header.buffer) && !hasEncodedAudioHeader(header.buffer)) { await reader.cancel(); throw new Error("Unsupported waveform format"); }
          bytes = new WaveformByteBuffer(expectedBytes);
          bytes.append(header); bytes.append(value.subarray(part.length));
        } else bytes.append(value);
      }
      if (!bytes) throw new Error("Unsupported waveform format");
      const buffer = bytes.finish();
      if (controller.signal.aborted) return;
      worker = new Worker(new URL("./waveform.worker.ts", import.meta.url), { type: "module" });
      const data = await new Promise<AudioWaveform>((resolve, reject) => {
        processingTimer = setTimeout(() => reject(new Error("Waveform processing limit")), 30_000);
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
        : error instanceof Error && error.message === "Preview busy"
        ? "Waveform previews are busy. Please try again shortly. Playback still works."
        : error instanceof Error && error.message === "Unsupported waveform format"
        ? "This recording's format or channel layout is not supported for waveform previews. Playback still works."
        : error instanceof Error && error.message === "Waveform decoder unavailable"
        ? "This browser cannot decode this recording's waveform. Playback still works; try a browser with WebCodecs audio support."
        : error instanceof Error && error.message === "Waveform processing limit"
        ? "This recording exceeds the safe waveform processing limit. Playback still works."
        : error instanceof Error && error.message === "Waveform decoding failed"
        ? "This recording's waveform could not be decoded. Playback still works; the file may be malformed or use an unsupported codec."
        : error instanceof Error && error.message === "Streaming buffer unavailable"
        ? "Waveform previews require a Content-Length header on this browser. Playback is still available."
        : "Waveform unavailable. Check recording access or bucket CORS settings, or refresh an expired storage link. Playback still works." });
    }).finally(() => {
      clearTimeout(processingTimer);
      controller.abort();
      worker?.terminate();
    });
    return () => {
      clearTimeout(processingTimer);
      controller.abort();
      worker?.terminate();
    };
  }, [src, enabled]);
  return state.src === src ? state : { src, loading: true };
}
