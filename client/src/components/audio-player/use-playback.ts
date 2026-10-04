import { useCallback, useEffect, useRef, useState } from "react";
import { clampTime } from "./utils";

export function usePlayback(src: string, onFrame: (time: number, duration: number) => void, onTimeChange?: (time: number) => void, decodedDuration = 0) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const frameCallback = useRef(onFrame);
  const timeCallback = useRef(onTimeChange);
  frameCallback.current = onFrame;
  timeCallback.current = onTimeChange;
  const frame = useRef(0);
  const scrub = useRef<{ time: number; original: number; resume: boolean } | null>(null);
  const generation = useRef(0);
  const lastUpdate = useRef(0);
  const durationFallback = useRef(decodedDuration);
  durationFallback.current = decodedDuration;
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string>();
  const [scrubbing, setScrubbing] = useState(false);

  const sample = useCallback((force = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    const current = scrub.current?.time ?? audio.currentTime;
    const total = Number.isFinite(audio.duration) ? audio.duration : durationFallback.current;
    frameCallback.current(current, total);
    if (force || performance.now() - lastUpdate.current > 100) {
      lastUpdate.current = performance.now();
      setTime(current);
      if (!scrub.current) timeCallback.current?.(current);
    }
  }, []);
  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    const requestedGeneration = generation.current;
    if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration) audio.currentTime = 0;
    try { await audio.play(); }
    catch {
      if (requestedGeneration === generation.current) setError("Recording could not be played. Try again or download it to listen locally.");
    }
  }, []);
  const seek = useCallback((target: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) ? audio.duration : durationFallback.current;
    if (!total) return;
    audio.currentTime = clampTime(target, total);
    sample(true);
  }, [sample]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const effectGeneration = ++generation.current;
    scrub.current = null;
    setTime(0); setDuration(0); setPlaying(false); setBuffering(false); setError(undefined); setScrubbing(false);
    frameCallback.current(0, 0);
    const tick = () => {
      sample();
      if (!audio.paused || scrub.current) frame.current = requestAnimationFrame(tick);
    };
    const metadata = () => { setDuration(Number.isFinite(audio.duration) ? audio.duration : durationFallback.current); sample(true); };
    const started = () => { setPlaying(true); setBuffering(false); setError(undefined); cancelAnimationFrame(frame.current); tick(); };
    const paused = () => { setPlaying(false); setBuffering(false); cancelAnimationFrame(frame.current); sample(true); };
    const waiting = () => setBuffering(true);
    const ready = () => { setBuffering(false); setError(undefined); };
    const failed = () => { setBuffering(false); setPlaying(false); setError("Recording could not be loaded. Check storage access or download it to listen locally."); };
    const updated = () => sample(true);
    const listeners = { loadedmetadata: metadata, durationchange: metadata, playing: started, pause: paused, ended: paused, waiting, canplay: ready, error: failed, timeupdate: updated };
    for (const [name, listener] of Object.entries(listeners)) audio.addEventListener(name, listener);
    // Cached media can have metadata before this effect attaches its listeners.
    if (audio.readyState >= 1) metadata();
    return () => {
      generation.current = effectGeneration + 1;
      for (const [name, listener] of Object.entries(listeners)) audio.removeEventListener(name, listener);
      cancelAnimationFrame(frame.current);
      audio.pause();
      scrub.current = null;
    };
  }, [src, sample]);
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) setDuration(Number.isFinite(audio.duration) ? audio.duration : decodedDuration);
    sample(true);
  }, [decodedDuration, sample]);

  const beginScrub = useCallback((target: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) ? audio.duration : durationFallback.current;
    if (total <= 0) return;
    scrub.current = { time: clampTime(target, total), original: audio.currentTime, resume: !audio.paused };
    audio.pause(); setScrubbing(true); sample(true);
  }, [sample]);
  const moveScrub = useCallback((target: number) => {
    const audio = audioRef.current;
    if (!scrub.current || !audio) return;
    scrub.current.time = clampTime(target, Number.isFinite(audio.duration) ? audio.duration : durationFallback.current);
    sample();
  }, [sample]);
  const endScrub = useCallback((cancel = false) => {
    const state = scrub.current;
    scrub.current = null;
    setScrubbing(false);
    if (!state) return;
    seek(cancel ? state.original : state.time);
    if (state.resume) void play();
  }, [play, seek]);
  return { audioRef, time, duration, playing, buffering, error, scrubbing, play, seek, beginScrub, moveScrub, endScrub,
    toggle: () => { if (audioRef.current?.paused) void play(); else audioRef.current?.pause(); } };
}
