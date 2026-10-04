import { BufferSource, EncodedPacketSink, Input, ALL_FORMATS } from "mediabunny";
import { MAX_AUDIO_CHANNELS, MAX_WAVEFORM_BYTES } from "./pcm-waveform";
import type { AudioWaveform } from "./types";

export const MAX_DECODED_FRAME_FRAMES = 65_536;
export const MAX_PREVIEW_SAMPLES = 512_000_000;
export const MAX_PREVIEW_SECONDS = 6 * 60 * 60;

export class WaveformPeakAccumulator {
  readonly channels: Float32Array[];
  private samples = 0;

  constructor(readonly duration: number, channelCount: number) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PREVIEW_SECONDS
      || !Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_AUDIO_CHANNELS) {
      throw new Error("Waveform processing limit");
    }
    this.channels = Array.from({ length: channelCount }, () => new Float32Array(4096));
  }

  add(data: Pick<AudioData, "numberOfFrames" | "numberOfChannels" | "sampleRate" | "timestamp" | "copyTo">, channelOffset: number, expectedChannels: number) {
    const { numberOfFrames: frames, numberOfChannels: channels, sampleRate: rate } = data;
    if (!Number.isInteger(frames) || frames < 1 || frames > MAX_DECODED_FRAME_FRAMES || channels !== expectedChannels
      || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || !Number.isFinite(data.timestamp)
      || channelOffset < 0 || channelOffset + channels > this.channels.length) throw new Error("Waveform processing limit");
    this.samples += frames * channels;
    if (this.samples > MAX_PREVIEW_SAMPLES) throw new Error("Waveform processing limit");
    // One small plane is reused across channels, never a full-recording PCM array.
    const plane = new Float32Array(frames);
    const firstBin = data.timestamp / 1e6 / this.duration * 4096;
    const binStep = 4096 / (rate * this.duration);
    for (let channel = 0; channel < channels; channel++) {
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      const peaks = this.channels[channelOffset + channel];
      for (let frame = 0; frame < frames; frame++) {
        const bin = Math.floor(firstBin + frame * binStep);
        const value = Math.abs(plane[frame]);
        if (bin >= 0 && bin < peaks.length && Number.isFinite(value)) peaks[bin] = Math.max(peaks[bin], Math.min(1, value));
      }
    }
  }
}

export async function encodedWaveform(bytes: ArrayBuffer): Promise<AudioWaveform> {
  if (bytes.byteLength > MAX_WAVEFORM_BYTES) throw new Error("Recording too large");
  if (typeof AudioDecoder === "undefined") throw new Error("Waveform decoder unavailable");
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    const tracks = await input.getAudioTracks();
    if (!tracks.length || tracks.length > MAX_AUDIO_CHANNELS) throw new Error("Unsupported waveform format");
    const configurations: AudioDecoderConfig[] = [];
    let channelCount = 0;
    for (const track of tracks) {
      const config = await track.getDecoderConfig();
      if (!config || !Number.isInteger(config.numberOfChannels) || config.numberOfChannels < 1
        || config.numberOfChannels > MAX_AUDIO_CHANNELS || !Number.isFinite(config.sampleRate)
        || config.sampleRate < 8000 || config.sampleRate > 192000 || (config.description?.byteLength ?? 0) > 64 * 1024) {
        throw new Error("Unsupported waveform format");
      }
      channelCount += config.numberOfChannels;
      if (channelCount > MAX_AUDIO_CHANNELS) throw new Error("Unsupported waveform format");
      if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error("Waveform decoder unavailable");
      configurations.push(config);
    }
    // Derive duration from packets, including MediaRecorder WebMs without a Duration element.
    const duration = await input.computeDuration(tracks);
    const peaks = new WaveformPeakAccumulator(duration, channelCount);
    let channelOffset = 0;
    for (let index = 0; index < tracks.length; index++) {
      const config = configurations[index];
      let failure: unknown;
      const decoder = new AudioDecoder({
        output(data) {
          try { if (!failure) peaks.add(data, channelOffset, config.numberOfChannels); }
          catch (error) { failure = error; }
          finally { data.close(); }
        },
        error(error) { failure = error; },
      });
      try {
        decoder.configure(config);
        const packets = new EncodedPacketSink(tracks[index]);
        let packet = await packets.getFirstPacket();
        let queued = 0;
        while (packet) {
          if (failure) throw failure;
          if (packet.data.byteLength > 1024 * 1024) throw new Error("Waveform processing limit");
          decoder.decode(packet.toEncodedAudioChunk());
          // Drain a small batch before submitting more compressed data.
          if (++queued === 8) { await decoder.flush(); queued = 0; }
          packet = await packets.getNextPacket(packet);
        }
        await decoder.flush();
        if (failure) throw failure;
      } finally {
        if (decoder.state !== "closed") decoder.close();
      }
      channelOffset += config.numberOfChannels;
    }
    return { duration, sampleRate: configurations[0].sampleRate, channels: peaks.channels };
  } finally { input.dispose(); }
}
