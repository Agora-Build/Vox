// Audio pipeline configuration — single source of truth.
// All audio capture, playback, broadcasting, and debug dumps use these values.
// Change here → changes everywhere.

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const FORMAT = "s16le";       // PulseAudio format string
export const BYTES_PER_SAMPLE = 2;   // s16le = 2 bytes

export const FORMAT_LABEL = `${SAMPLE_RATE}hz_${CHANNELS}ch_${FORMAT}`;

/** Build parec args for capturing from a monitor source */
export function parecArgs(device: string): string[] {
  return [
    `-d`, device,
    `--format=${FORMAT}`,
    `--rate=${SAMPLE_RATE}`,
    `--channels=${CHANNELS}`,
    "--raw",
  ];
}

/** Build pacat args for playing raw PCM into a sink */
export function pacatArgs(sink: string): string[] {
  return [
    "-d", sink,
    `--format=${FORMAT}`,
    `--rate=${SAMPLE_RATE}`,
    `--channels=${CHANNELS}`,
    "--raw",
  ];
}

/** Sox format args for merging raw PCM files */
export const SOX_RAW_ARGS = `-r ${SAMPLE_RATE} -e signed -b ${BYTES_PER_SAMPLE * 8} -c ${CHANNELS}`;
