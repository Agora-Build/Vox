export interface AudioTranscriptSegment {
  id?: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  channel?: number;
}

export interface AudioChannel {
  label: string;
  color?: string;
}

export interface AudioPlayerProps {
  src: string;
  waveformSrc?: string;
  title?: string;
  subtitle?: string;
  channels?: readonly AudioChannel[];
  transcript?: readonly AudioTranscriptSegment[];
  transcriptLoading?: boolean;
  transcriptError?: string;
  transcriptNote?: string;
  showTranscript?: boolean;
  downloadUrl?: string;
  className?: string;
  onTimeChange?: (seconds: number) => void;
}

export interface AudioWaveform {
  duration: number;
  sampleRate: number;
  channels: Float32Array[];
}
