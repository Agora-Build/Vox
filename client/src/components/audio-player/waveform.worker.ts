import { hasWaveHeader, pcmWaveform } from "./pcm-waveform";
import { encodedWaveform } from "./encoded-waveform";

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const data = hasWaveHeader(event.data.bytes) ? pcmWaveform(event.data.bytes) : await encodedWaveform(event.data.bytes);
    self.postMessage({ data }, { transfer: data.channels.map((channel) => channel.buffer) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    self.postMessage({ error: ["Recording too large", "Unsupported waveform format", "Waveform decoder unavailable", "Waveform processing limit"].includes(reason) ? reason : "Waveform decoding failed" });
  }
};
