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
