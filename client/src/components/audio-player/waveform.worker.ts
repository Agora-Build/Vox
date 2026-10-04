import { pcmWaveform } from "./pcm-waveform";

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const data = pcmWaveform(event.data.bytes);
    self.postMessage({ data }, { transfer: data.channels.map((channel) => channel.buffer) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Waveform processing failed" });
  }
};
