import { useEffect, useRef, useState } from "react";
import { Captions, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AudioTranscriptSegment } from "./types";
import { formatAudioTime } from "./utils";

export function AudioTranscript({ segments, time, playing, loading, error, note, onSeek }: {
  segments: readonly AudioTranscriptSegment[]; time: number; playing: boolean; loading?: boolean; error?: string; note?: string; onSeek: (time: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const active = segments.findIndex((segment) => segment.start <= time && segment.end > time);
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
    {loading ? <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Loading transcript...</p>
      : !segments.length ? <p className="px-5 pb-4 text-sm text-muted-foreground">{error ?? "No timed transcript is available for this recording."}</p>
      : <div ref={listRef} className="audio-transcript-list" onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
        {segments.map((segment, index) => <button key={segment.id ?? index} type="button" data-segment-index={index}
          aria-current={segment.start <= time && segment.end > time ? "true" : undefined} onClick={() => onSeek(segment.start)} className={`audio-transcript-row ${segment.start <= time && segment.end > time ? "is-active" : ""}`}>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{formatAudioTime(segment.start)}</span>
          <span className="min-w-0"><span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{segment.speaker ?? (segment.channel != null ? `Channel ${segment.channel + 1}` : "Speech")}</span><span className="block text-sm leading-relaxed">{segment.text}</span></span>
        </button>)}
      </div>}
  </section>;
}
