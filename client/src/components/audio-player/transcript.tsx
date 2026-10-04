import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Captions, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AudioTranscriptSegment } from "./types";
import { activeTranscriptIndex, formatAudioTime, transcriptEndIndex } from "./utils";

const TranscriptRow = memo(function TranscriptRow({ segment, index, active, onSeek }: {
  segment: AudioTranscriptSegment; index: number; active: boolean; onSeek: (time: number) => void;
}) {
  return <button type="button" data-segment-index={index} aria-current={active ? "true" : undefined} onClick={() => onSeek(segment.start)} className={`audio-transcript-row ${active ? "is-active" : ""}`}>
    <span className="font-mono text-xs tabular-nums text-muted-foreground">{formatAudioTime(segment.start)}</span>
    <span className="min-w-0"><span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{segment.speaker ?? (segment.channel != null ? `Channel ${segment.channel + 1}` : "Speech")}</span><span className="block text-sm leading-relaxed">{segment.text}</span></span>
  </button>;
});

export function AudioTranscript({ segments, time, playing, loading, error, note, limited, onSeek }: {
  segments: readonly AudioTranscriptSegment[]; time: number; playing: boolean; loading?: boolean; error?: string; note?: string; limited?: boolean; onSeek: (time: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const ends = useMemo(() => transcriptEndIndex(segments), [segments]);
  const active = activeTranscriptIndex(segments, ends, time);
  useEffect(() => {
    if (!follow || !playing || active < 0) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-segment-index="${active}"]`);
    if (!list || !row) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: "smooth" });
    }
  }, [active, follow, playing]);
  return <section className="audio-transcript" aria-label="Recording transcript">
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Captions className="h-4 w-4 text-muted-foreground" /> Transcript <span className="text-xs font-normal text-muted-foreground">{segments.length ? `${segments.length} segments` : ""}</span></h3>
      {segments.length > 0 && <Button variant="ghost" size="sm" aria-pressed={follow} onClick={() => setFollow(!follow)} className="h-7 gap-1.5 text-xs"><LocateFixed className="h-3.5 w-3.5" /> Follow playback</Button>}
    </div>
    {note && segments.length > 0 && <p className="px-5 pb-2 text-xs text-muted-foreground">{note}</p>}
    {limited && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground">Transcript preview is limited to 1,000 segments and 4,000 characters per segment. Additional transcript content is not shown in this preview.</p>}
    {loading ? <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Loading transcript...</p>
      : !segments.length ? <p className="px-5 pb-4 text-sm text-muted-foreground">{error ?? "No timed transcript is available for this recording."}</p>
      : <div ref={listRef} className="audio-transcript-list" onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
        {segments.map((segment, index) => <TranscriptRow key={segment.id ?? index} segment={segment} index={index} active={segment.start <= time && segment.end > time} onSeek={onSeek} />)}
      </div>}
  </section>;
}
