import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Smart timestamp: relative for recent, absolute for older.
 * < 60 min: "X minutes ago"
 * 1–8 hours: "X hours ago"
 * >= 8 hours: "2026-03-04 09:00:42"
 */
export const REGIONS = [
  { value: "na", label: "North America" },
  { value: "apac", label: "Asia Pacific" },
  { value: "eu", label: "Europe" },
  { value: "sa", label: "South America" },
] as const;

export function formatRegion(region: string): string {
  return REGIONS.find(r => r.value === region.toLowerCase())?.label ?? region;
}

// Render a JS value as readable YAML for read-only config display (workflow/eval-set
// snapshots, app config). Not a full YAML serializer — good enough for display.
export function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return obj.includes("\n") ? `|\n${obj.split("\n").map(l => pad + "  " + l).join("\n")}` : `"${obj}"`;
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) {
    return obj.map(item => {
      const val = toYaml(item, indent + 1);
      const isComplex = typeof item === "object" && item !== null;
      return isComplex ? `${pad}- ${val.trimStart()}` : `${pad}- ${val}`;
    }).join("\n");
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries.map(([key, val]) => {
    if (typeof val === "object" && val !== null) {
      return `${pad}${key}:\n${toYaml(val, indent + 1)}`;
    }
    return `${pad}${key}: ${toYaml(val, indent)}`;
  }).join("\n");
}

export function formatSmartTimestamp(dateStr: string | Date): string {
  const date = dateStr instanceof Date ? dateStr : new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) {
    const diffSec = Math.floor(diffMs / 1000);
    return diffSec < 5 ? "Just now" : `${diffSec} seconds ago`;
  }
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  if (diffHr < 8) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  return format(date, "yyyy-MM-dd HH:mm:ss");
}
