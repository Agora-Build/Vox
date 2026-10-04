import { memo, useEffect, useRef } from "react";

export const WaveformLane = memo(function WaveformLane({ peaks }: { peaks: Float32Array }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = baseRef.current;
    const played = playedRef.current;
    if (!canvas || !played) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const color = getComputedStyle(canvas).color;
      for (const [surface, alpha] of [[canvas, 0.3], [played, 1]] as const) {
        surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio);
        const ctx = surface.getContext("2d");
        if (!ctx) continue;
        ctx.scale(ratio, ratio);
        ctx.fillStyle = color; ctx.globalAlpha = alpha;
        const bars = Math.min(peaks.length, Math.max(1, Math.floor(width / 3)));
        for (let index = 0; index < bars; index++) {
          let peak = 0;
          for (let bin = Math.floor(index * peaks.length / bars); bin < Math.floor((index + 1) * peaks.length / bars); bin++) peak = Math.max(peak, peaks[bin]);
          const amplitude = Math.max(0.75, peak * height * 0.43);
          ctx.fillRect(index * width / bars, height / 2 - amplitude, Math.max(1, width / bars - 1.5), amplitude * 2);
        }
      }
    };
    const resize = new ResizeObserver(draw); resize.observe(canvas);
    const theme = new MutationObserver(draw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", draw); draw();
    return () => { resize.disconnect(); theme.disconnect(); window.removeEventListener("resize", draw); };
  }, [peaks]);
  return <div className="audio-waveform-lane" aria-hidden="true">
    <canvas ref={baseRef} />
    <canvas ref={playedRef} className="audio-waveform-played" />
  </div>;
});
