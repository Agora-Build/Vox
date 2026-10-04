import { memo, useEffect, useRef } from "react";
import { waveformCanvasSize } from "./utils";

export const WaveformLane = memo(function WaveformLane({ peaks }: { peaks: Float32Array }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = baseRef.current;
    const played = playedRef.current;
    if (!canvas || !played) return;
    const lane = canvas.parentElement!;
    const viewport = canvas.closest<HTMLElement>(".audio-wave-scroll");
    if (!viewport) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const timelineWidth = lane.clientWidth;
      const width = Math.min(timelineWidth, viewport.clientWidth);
      const height = lane.clientHeight;
      if (!width || !height) return;
      const left = Math.min(viewport.scrollLeft, Math.max(0, timelineWidth - width));
      const backing = waveformCanvasSize(width, height, window.devicePixelRatio);
      const firstBin = Math.floor(left / timelineWidth * peaks.length);
      const lastBin = Math.min(peaks.length, Math.ceil((left + width) / timelineWidth * peaks.length));
      const color = getComputedStyle(canvas).color;
      for (const [surface, alpha] of [[canvas, 0.3], [played, 1]] as const) {
        surface.style.left = `${left}px`; surface.style.width = `${width}px`;
        surface.width = backing.width; surface.height = backing.height;
        const ctx = surface.getContext("2d");
        if (!ctx) continue;
        ctx.scale(backing.width / width, backing.height / height);
        ctx.fillStyle = color; ctx.globalAlpha = alpha;
        const bars = Math.min(lastBin - firstBin, Math.max(1, Math.floor(width / 3)));
        for (let index = 0; index < bars; index++) {
          let peak = 0;
          for (let bin = firstBin + Math.floor(index * (lastBin - firstBin) / bars); bin < firstBin + Math.floor((index + 1) * (lastBin - firstBin) / bars); bin++) peak = Math.max(peak, peaks[bin]);
          const amplitude = Math.max(0.75, peak * height * 0.43);
          ctx.fillRect(index * width / bars, height / 2 - amplitude, Math.max(1, width / bars - 1.5), amplitude * 2);
        }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(schedule); resize.observe(lane); resize.observe(viewport);
    const theme = new MutationObserver(schedule); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule); draw();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect(); viewport.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [peaks]);
  return <div className="audio-waveform-lane" aria-hidden="true">
    <canvas ref={baseRef} />
    <div className="audio-waveform-played"><canvas ref={playedRef} /></div>
  </div>;
});
