import { useEffect, useState } from "react";
import type { AudioWaveform } from "./types";

const MAX_WAVEFORM_BYTES = 64 * 1024 * 1024;

export function useWaveform(src: string) {
  const [state, setState] = useState<{ src: string; data?: AudioWaveform; loading: boolean; error?: string }>({ src, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    let context: AudioContext | undefined;
    let worker: Worker | undefined;
    setState({ src, loading: true });
    const load = async () => {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error("Recording unavailable");
      if (Number(response.headers.get("Content-Length")) > MAX_WAVEFORM_BYTES) {
        await response.body?.cancel();
        throw new Error("Recording too large");
      }
      // Read incrementally so a missing Content-Length cannot bypass the memory cap.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Streaming is unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_WAVEFORM_BYTES) {
          await reader.cancel();
          throw new Error("Recording too large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (controller.signal.aborted) return;
      context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes.buffer);
      if (controller.signal.aborted) return;
      worker = new Worker(new URL("./waveform.worker.ts", import.meta.url), { type: "module" });
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice());
      const peaks = await new Promise<Float32Array[]>((resolve, reject) => {
        const aborted = () => reject(new DOMException("Waveform cancelled", "AbortError"));
        controller.signal.addEventListener("abort", aborted, { once: true });
        worker!.onmessage = (event: MessageEvent<Float32Array[]>) => {
          controller.signal.removeEventListener("abort", aborted);
          resolve(event.data);
        };
        worker!.onerror = () => {
          controller.signal.removeEventListener("abort", aborted);
          reject(new Error("Waveform processing failed"));
        };
        worker!.postMessage({ channels }, channels.map((channel) => channel.buffer));
      });
      if (!controller.signal.aborted) setState({ src, data: { duration: buffer.duration, sampleRate: buffer.sampleRate, channels: peaks }, loading: false });
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ src, loading: false, error: error instanceof Error && error.message === "Recording too large"
        ? "Waveform previews are limited to recordings under 64 MB. Playback still works."
        : "Waveform unavailable. Playback still works; the format or storage permissions may not allow waveform decoding." });
    }).finally(() => {
      worker?.terminate();
      if (context && context.state !== "closed") void context.close().catch(() => {});
    });
    return () => {
      controller.abort();
      worker?.terminate();
      if (context && context.state !== "closed") void context.close().catch(() => {});
    };
  }, [src]);
  return state.src === src ? state : { src, loading: true };
}
