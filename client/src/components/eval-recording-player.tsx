import { useEffect, useMemo, useState } from "react";
import { AudioPlayer, type AudioTranscriptSegment } from "@/components/audio-player";
import { findRecordingTranscript, parseRecordingTranscript, transcriptFromMetrics, type RecordingArtifact } from "@/lib/recording-transcript";
import { fetchPreview } from "@/lib/preview-fetch";

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

export function EvalRecordingPlayer({ recording, artifacts, rawData }: { recording: RecordingArtifact; artifacts: readonly RecordingArtifact[]; rawData: unknown }) {
  const transcriptFile = findRecordingTranscript(recording.name, artifacts);
  const url = transcriptFile?.previewUrl ?? transcriptFile?.url;
  const [loaded, setLoaded] = useState<{ url: string; segments?: AudioTranscriptSegment[]; loading: boolean; error?: string }>();
  const fallback = useMemo(() => transcriptFromMetrics(rawData, recording.name), [rawData, recording.name]);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setLoaded({ url, loading: true });
    const load = async () => {
      const response = await fetchPreview(url, controller.signal);
      if (!response.ok) throw new Error("Transcript unavailable");
      if (Number(response.headers.get("Content-Length")) > MAX_TRANSCRIPT_BYTES) {
        await response.body?.cancel(); throw new Error("Transcript too large");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Transcript unavailable");
      const decoder = new TextDecoder();
      let text = ""; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TRANSCRIPT_BYTES) { await reader.cancel(); throw new Error("Transcript too large"); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const segments = parseRecordingTranscript(text);
      if (!controller.signal.aborted) setLoaded({ url, segments, loading: false });
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ url, loading: false, error: error instanceof Error && error.message === "Preview busy"
        ? "Transcript previews are busy. Please try again shortly. Playback is still available."
        : "Transcript could not be loaded. Playback is still available." });
    });
    return () => controller.abort();
  }, [url]);
  const current = loaded?.url === url ? loaded : undefined;
  const precise = !!current?.segments?.length;
  return <AudioPlayer src={recording.url} waveformSrc={recording.previewUrl} title={recording.name.split("/").pop()} subtitle={`${recording.name} · ${(recording.size / (1024 * 1024)).toFixed(1)} MB`}
    transcript={precise ? current.segments : fallback} transcriptNote={!precise && fallback.length ? "Turn-level timing; precise speech boundaries are not available." : undefined}
    transcriptLoading={!!url && (!current || current.loading)} transcriptError={current?.error} downloadUrl={recording.url} />;
}
