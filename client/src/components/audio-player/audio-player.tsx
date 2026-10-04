import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { AudioLines, Captions, Download, Loader2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AudioPlayerProps } from "./types";
import { usePlayback } from "./use-playback";
import { useWaveform } from "./use-waveform";
import { AudioTranscript } from "./transcript";
import { WaveformLane } from "./waveform-lane";
import { formatAudioTime, MAX_TRANSCRIPT_SEGMENTS, MAX_TRANSCRIPT_TEXT, normalizeTranscript, timelineTicks } from "./utils";
import "./audio-player.css";

export function AudioPlayer({ src, waveformSrc, title = "Recording", subtitle, channels, transcript = [], transcriptLoading, transcriptError, transcriptNote, showTranscript = true, downloadUrl, className, onTimeChange }: AudioPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const pointerRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [waveformEnabled, setWaveformEnabled] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setWaveformEnabled(true); observer.disconnect(); }
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const onFrame = useCallback((time: number, duration: number) => {
    const progress = duration > 0 ? Math.min(100, time / duration * 100) : 0;
    // Only the playhead/clip changes each frame; canvas peaks stay static.
    rootRef.current?.style.setProperty("--player-progress", `${progress}%`);
    playheadRef.current?.classList.toggle("is-near-end", progress > 90);
    if (timeLabelRef.current) timeLabelRef.current.textContent = formatAudioTime(time, true);
  }, []);
  const waveform = useWaveform(waveformSrc ?? src, waveformEnabled);
  const playback = usePlayback(src, onFrame, onTimeChange, waveform.data?.duration);
  const segments = useMemo(() => normalizeTranscript(transcript), [transcript]);
  const transcriptLimited = useMemo(() => transcript.length > MAX_TRANSCRIPT_SEGMENTS || transcript.slice(0, MAX_TRANSCRIPT_SEGMENTS).some((segment) => typeof segment.text === "string" && segment.text.length > MAX_TRANSCRIPT_TEXT), [transcript]);
  const ticks = useMemo(() => timelineTicks(playback.duration, zoom), [playback.duration, zoom]);
  const atPointer = (event: PointerEvent) => {
    const rect = timelineRef.current!.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width * playback.duration;
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!playback.duration || pointerRef.current != null || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    playback.beginScrub(atPointer(event));
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    if (!cancel) playback.moveScrub(atPointer(event));
    playback.endScrub(cancel);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyDown = (event: KeyboardEvent) => {
    const targets: Record<string, number> = { ArrowLeft: playback.time - 5, ArrowRight: playback.time + 5, ArrowDown: playback.time - 5, ArrowUp: playback.time + 5, PageDown: playback.time - 10, PageUp: playback.time + 10, Home: 0, End: playback.duration };
    if (event.key in targets) { event.preventDefault(); playback.seek(targets[event.key]); }
    if (event.key === " ") { event.preventDefault(); playback.toggle(); }
  };
  return <div ref={rootRef} className={cn("vox-audio-player", className)} data-testid="audio-player" aria-label={`${title} audio player`}>
    <audio ref={playback.audioRef} src={src} preload="metadata" controls={playback.unknownDuration} className="w-full px-4 sm:px-5" style={{ display: playback.unknownDuration ? "block" : "none" }} aria-label={`${title} native audio controls`} data-testid="player-audio" onLoadedMetadata={() => {
      const audio = playback.audioRef.current;
      if (audio) { audio.defaultPlaybackRate = rate; audio.playbackRate = rate; audio.volume = volume; }
    }} />
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
      <div className="min-w-0 flex-1"><p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><AudioLines className="h-3.5 w-3.5" /> Recording studio</p><h3 className="break-words text-sm font-medium">{title}</h3>{subtitle && <p className="mt-1 break-words text-xs text-muted-foreground">{subtitle}</p>}</div>
      <div className="flex shrink-0 items-center gap-1">
        {showTranscript && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Show transcript" aria-pressed={transcriptOpen} onClick={() => setTranscriptOpen(!transcriptOpen)}><Captions className="h-4 w-4" /></Button>}
        {downloadUrl && <Button variant="ghost" size="icon" asChild className="h-8 w-8"><a href={downloadUrl} download aria-label="Download recording"><Download className="h-4 w-4" /></a></Button>}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back 10 seconds" disabled={!playback.duration && !playback.unknownDuration} onClick={() => playback.seek(playback.time - 10)}><RotateCcw className="h-4 w-4" /></Button>
        <Button size="icon" className="h-11 w-11 rounded-full shadow-lg shadow-primary/10" aria-label={playback.playing ? "Pause recording" : "Play recording"} onClick={playback.toggle}>{playback.buffering ? <Loader2 className="h-5 w-5 animate-spin" /> : playback.playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="ml-0.5 h-5 w-5 fill-current" />}</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Forward 10 seconds" disabled={!playback.duration && !playback.unknownDuration} onClick={() => playback.seek(playback.time + 10)}><RotateCw className="h-4 w-4" /></Button>
      </div>
      <div className="font-mono text-xs tabular-nums"><span data-testid="player-current-time">{formatAudioTime(playback.time, true)}</span><span className="mx-2 text-muted-foreground">/</span><span className="text-muted-foreground">{playback.unknownDuration ? "--:--" : formatAudioTime(playback.duration)}</span></div>
      <div className="ml-auto flex items-center gap-2">
        <select aria-label="Playback speed" className="h-8 rounded-md border bg-background px-2 font-mono text-xs" value={rate} onChange={(event) => { const next = Number(event.target.value); setRate(next); if (playback.audioRef.current) { playback.audioRef.current.defaultPlaybackRate = next; playback.audioRef.current.playbackRate = next; } }}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed}x</option>)}
        </select>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={volume ? "Mute recording" : "Unmute recording"} onClick={() => { const next = volume ? 0 : 1; setVolume(next); if (playback.audioRef.current) playback.audioRef.current.volume = next; }}>{volume ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</Button>
        <input type="range" min="0" max="1" step="0.05" aria-label="Recording volume" value={volume} className="hidden w-16 accent-primary sm:block" onChange={(event) => { const next = Number(event.target.value); setVolume(next); if (playback.audioRef.current) playback.audioRef.current.volume = next; }} />
      </div>
    </div>
    {playback.error && <p role="alert" className="px-5 pb-3 text-sm text-destructive">{playback.error}</p>}
    {playback.unknownDuration && <p className="px-5 pb-3 text-xs text-muted-foreground">This recording has no duration metadata. Native audio controls remain available for seeking.</p>}
    <div className="mx-3 overflow-hidden rounded-lg border bg-background/60 sm:mx-4">
      <div className="audio-wave-scroll">
        <div ref={timelineRef} className="audio-wave-timeline" style={{ width: `${zoom * 100}%` }} role="slider" tabIndex={0}
          aria-label="Recording timeline" aria-valuemin={0} aria-valuemax={playback.duration} aria-valuenow={Math.min(playback.time, playback.duration)} aria-valuetext={formatAudioTime(playback.time, true)} aria-disabled={!playback.duration}
          onPointerDown={down} onPointerMove={(event) => { if (pointerRef.current === event.pointerId) playback.moveScrub(atPointer(event)); }}
          onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)} onKeyDown={keyDown}>
          {waveform.data?.channels.map((peaks, index) => <div key={index} className="audio-channel-row" data-testid="player-channel" style={{ "--channel-color": channels?.[index]?.color ?? `var(--audio-channel-${index % 6 + 1})` } as CSSProperties}>
            <span className="audio-channel-label">{channels?.[index]?.label ?? `Channel ${String(index + 1).padStart(2, "0")}`}</span>
            <WaveformLane peaks={peaks} />
          </div>)}
          {!waveform.data && <div className="flex min-h-36 items-center justify-center px-5 text-center text-xs text-muted-foreground" role="status">{waveform.loading ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Building channel waveforms...</span> : waveform.error}</div>}
          <div ref={playheadRef} className="audio-playhead"><span ref={timeLabelRef} className="audio-playhead-time">00:00.00</span></div>
          <div className="audio-time-ruler" aria-hidden="true">{ticks.map((tick) => <span key={tick} style={{ left: `${tick / playback.duration * 100}%` }}>{formatAudioTime(tick)}</span>)}</div>
        </div>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-muted-foreground sm:px-5">
      <span>{playback.scrubbing ? "Release to seek" : "Drag the waveform to seek"}{waveform.data ? ` · ${waveform.data.channels.length} channel${waveform.data.channels.length === 1 ? "" : "s"}` : ""}</span>
      <div className="flex items-center gap-1"><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Zoom out waveform" disabled={zoom === 1} onClick={() => setZoom(Math.max(1, zoom / 2))}><ZoomOut className="h-3.5 w-3.5" /></Button><span className="w-6 text-center font-mono">{zoom}x</span><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Zoom in waveform" disabled={zoom === 8} onClick={() => setZoom(Math.min(8, zoom * 2))}><ZoomIn className="h-3.5 w-3.5" /></Button></div>
    </div>
    {showTranscript && transcriptOpen && <AudioTranscript segments={segments} limited={transcriptLimited} time={playback.time} playing={playback.playing} loading={transcriptLoading} error={transcriptError} note={transcriptNote} onSeek={playback.seek} />}
  </div>;
}
