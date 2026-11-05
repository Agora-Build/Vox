/**
 * The access toggle's state and the leaderboard's split-column rule, both read
 * from the page's `tag=` filters (designs/2026-10-22-network-tags-design.md
 * "Last mile vs datacenter" → Analysis). Dependency-free so it can be unit
 * tested on its own; the toggle itself lives in components/metrics-tag-controls.
 */
import type { Tag } from "@shared/tags";

export type AccessView = "all" | "lastmile" | "datacenter";

/**
 * Which access class the tag filters are narrowed to — the toggle's state.
 * "other" is an access filter the toggle has no button for (e.g.
 * `tag=access:unknown` from a URL): no button is pressed, and it is NOT All.
 */
export function accessView(tagFilters: Tag[]): AccessView | "other" {
  const v = tagFilters.find((t) => t.key === "access")?.value;
  if (v === undefined) return "all";
  return v === "lastmile" || v === "datacenter" ? v : "other";
}

/** The leaderboard's last mile / datacenter split columns only make sense with no access filter at all. */
export function showAccessSplit(tagFilters: Tag[]): boolean {
  return !tagFilters.some((t) => t.key === "access");
}

/** The tag filters with the access filter set to `view` (All removes it). */
export function withAccessView(tagFilters: Tag[], view: AccessView): Tag[] {
  const rest = tagFilters.filter((t) => t.key !== "access");
  return view === "all" ? rest : [...rest, { key: "access", value: view }];
}

