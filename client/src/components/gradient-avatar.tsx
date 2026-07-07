import { cn } from "@/lib/utils";

// Deterministic hash → stable per-name value (no Math.random, so it never flickers).
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Image-free, modern avatar: a per-user diagonal gradient (two hues derived from
 * the name) with the initial. Distinct per user, zero storage. Size/text via
 * `className` (e.g. "h-9 w-9 text-sm").
 */
export function GradientAvatar({ name, className }: { name: string; className?: string }) {
  const seed = hashSeed(name || "?");
  const h1 = seed % 360;
  const h2 = (h1 + 40 + (seed % 60)) % 360;
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-semibold text-white select-none shadow-sm ring-1 ring-black/10",
        className,
      )}
      style={{ background: `linear-gradient(135deg, hsl(${h1} 75% 58%), hsl(${h2} 68% 42%))` }}
      aria-hidden
    >
      <span className="drop-shadow-sm">{initial}</span>
    </div>
  );
}
