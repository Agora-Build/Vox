import { buildWaveformPeaks } from "./utils";

self.onmessage = (event: MessageEvent<{ channels: Float32Array[] }>) => {
  const peaks = event.data.channels.map((samples) => buildWaveformPeaks(samples));
  self.postMessage(peaks, { transfer: peaks.map((channel) => channel.buffer) });
};
