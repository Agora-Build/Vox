import type { AudioTranscriptSegment } from "./types";

export const MAX_TRANSCRIPT_SEGMENTS = 1000;
export const MAX_TRANSCRIPT_TEXT = 4000;

export function waveformCanvasSize(width: number, height: number, dpr: number) {
  const ratio = Number.isFinite(dpr) ? Math.max(1, Math.min(dpr, 2)) : 1;
  return { width: Math.max(1, Math.min(2048, Math.round(width * ratio))), height: Math.max(1, Math.min(128, Math.round(height * ratio))) };
}

export function clampTime(time: number, duration: number) {
  return Number.isFinite(time) && Number.isFinite(duration) ? Math.max(0, Math.min(time, Math.max(0, duration))) : 0;
}

export function formatAudioTime(time: number, precise = false) {
  const safe = Number.isFinite(time) ? Math.max(0, time) : 0;
  const hundredths = Math.floor(safe * 100 + 0.000001);
  const seconds = Math.floor(hundredths / 100);
  const hours = Math.floor(seconds / 3600);
  const clock = `${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${hours ? `${hours}:` : ""}${clock}${precise ? `.${String(hundredths % 100).padStart(2, "0")}` : ""}`;
}

export function timelineTicks(duration: number, zoom = 1) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const desired = duration / (6 * (Number.isFinite(zoom) ? Math.max(1, zoom) : 1));
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = ([1, 2, 5, 10].find((n) => n * power >= desired) ?? 10) * power;
  const count = Math.min(100, Math.floor(duration / step));
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

export function normalizeTranscript(segments: readonly AudioTranscriptSegment[]) {
  return segments.slice(0, MAX_TRANSCRIPT_SEGMENTS).filter((segment) => Number.isFinite(segment.start) && segment.start >= 0
    && Number.isFinite(segment.end) && segment.end > segment.start && typeof segment.text === "string" && segment.text.trim())
    .map((segment) => ({ ...segment, text: segment.text.length > MAX_TRANSCRIPT_TEXT ? `${segment.text.slice(0, MAX_TRANSCRIPT_TEXT).trim()}...` : segment.text.trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function transcriptEndIndex(segments: readonly AudioTranscriptSegment[]) {
  let end = 0;
  return segments.map((segment) => { end = Math.max(end, segment.end); return end; });
}

export function activeTranscriptIndex(segments: readonly AudioTranscriptSegment[], ends: readonly number[], time: number) {
  let left = 0; let right = ends.length;
  // Prefix-max ends find the first active segment even when speech overlaps.
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (ends[middle] <= time) left = middle + 1;
    else right = middle;
  }
  return left < segments.length && segments[left].start <= time ? left : -1;
}

export function buildWaveformPeaks(samples: Float32Array, bins = 4096) {
  const count = Math.min(samples.length, Number.isFinite(bins) ? Math.max(1, Math.floor(bins)) : 4096);
  const peaks = new Float32Array(count);
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor(bin * samples.length / count);
    const end = Math.floor((bin + 1) * samples.length / count);
    let peak = 0;
    for (let index = start; index < end; index++) {
      const value = Math.abs(samples[index]);
      if (Number.isFinite(value)) peak = Math.max(peak, Math.min(1, value));
    }
    peaks[bin] = peak;
  }
  return peaks;
}
