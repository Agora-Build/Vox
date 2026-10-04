import type { AudioTranscriptSegment } from "../components/audio-player/types";

export interface RecordingArtifact { name: string; url: string; size: number; contentType: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function findRecordingTranscript(recording: string, files: readonly RecordingArtifact[]) {
  const candidates = files.filter((file) => /(?:^|\/)turns\.json$/i.test(file.name)).map((file) => {
    const folder = file.name.slice(0, -"turns.json".length).replace(/(?:^|\/)analysis\/$/i, "/").replace(/^\//, "");
    return { file, folder };
  }).filter(({ folder }) => recording.startsWith(folder) && (folder.length > 0 || !/^vox-[^/]+\//.test(recording))).sort((a, b) => b.folder.length - a.folder.length);
  // Each chunk has its own clock. Never reuse a transcript from another chunk.
  return candidates.length && (candidates.length === 1 || candidates[0].folder.length > candidates[1].folder.length) ? candidates[0].file : undefined;
}

export function parseRecordingTranscript(text: string): AudioTranscriptSegment[] {
  // Python's non-finite JSON tokens occur in metrics, not inside quoted speech.
  const sanitized = text.replace(/"(?:\\.|[^"\\])*"|([:[,\s]+)(?:-?Infinity|NaN)(?=\s*[,}\]])/g,
    (match, prefix: string | undefined) => prefix ? `${prefix}null` : match);
  const data: unknown = JSON.parse(sanitized);
  if (!Array.isArray(data)) throw new Error("Unsupported transcript format");
  const segments: AudioTranscriptSegment[] = [];
  for (const item of data) {
    const turn = record(item);
    for (const [field, speaker, channel] of [["user_segments", "User", 0], ["agent_segments", "Agent", 1]] as const) {
      if (!Array.isArray(turn[field])) continue;
      for (const value of turn[field]) {
        const segment = record(value);
        if (typeof segment.start === "number" && typeof segment.end === "number" && typeof segment.text === "string") {
          segments.push({ start: segment.start, end: segment.end, text: segment.text, speaker, channel });
        }
      }
    }
  }
  return segments;
}

export function transcriptFromMetrics(rawData: unknown, recordingName: string): AudioTranscriptSegment[] {
  const raw = record(rawData);
  const all = ["response_metrics", "interruption_metrics"].flatMap((family) => {
    const turns = record(record(raw[family]).latency).turn_level;
    return Array.isArray(turns) ? turns.map(record) : [];
  });
  const groups = Array.from(new Set(all.map((turn) => `${turn.case_id ?? ""}\u0000${turn.chunk_id ?? ""}`)));
  const safe = (value: unknown) => String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const selected = groups.length > 1 ? all.filter((turn) => turn.case_id != null && turn.chunk_id != null && recordingName.includes(`vox-${safe(turn.case_id)}-${safe(turn.chunk_id)}-`)) : all;
  const selectedGroups = new Set(selected.map((turn) => `${turn.case_id ?? ""}\u0000${turn.chunk_id ?? ""}`));
  if (selectedGroups.size > 1) return [];
  const segments = new Map<string, AudioTranscriptSegment>();
  for (const turn of selected) {
    if (typeof turn.turn_start !== "number" || typeof turn.turn_end !== "number") continue;
    for (const [field, speaker, channel] of [["user_transcript", "User", 0], ["agent_transcript", "Agent", 1]] as const) {
      if (typeof turn[field] !== "string" || !turn[field]) continue;
      const segment = { start: turn.turn_start, end: turn.turn_end, text: turn[field], speaker, channel };
      segments.set(JSON.stringify(segment), segment);
    }
  }
  return Array.from(segments.values());
}
