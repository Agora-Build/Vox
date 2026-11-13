import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TagInput } from "@/components/tag-input";
import { formatRegion } from "@/lib/utils";
import { LAST_MILE_HINT, DATACENTER_HINT } from "@/lib/access-text";
import { accessView, withAccessView, type AccessView } from "@/lib/access-view";
import { KNOWN_TAG_KEYS, MAX_TAG_FILTERS, REGION_GROUP_KEY, formatTag, type Tag } from "@shared/tags";
import type { HealthMode } from "@shared/metrics";

/**
 * The network-tag knobs of a metrics view (designs/2026-10-22-network-tags-design.md
 * "Analysis"): `tag=key:value` filters (all must match) and `groupBy=key`.
 * Selections are local to the page and reset to All networks on reload.
 */

const KNOWN_KEY_LABELS: Record<string, string> = {
  line: "line provider",
  isp: "network",
  link: "connection",
  access: "last mile / datacenter",
  sim: "SIM operator",
};

/** Transient health and tag filters; every page load starts with All and Strict off. */
export function useMetricsTagState() {
  const [tagFilters, setTagFilters] = useState<Tag[]>([]);
  const [groupBy, setGroupBy] = useState<string | undefined>();
  const [health, setHealth] = useState<HealthMode>("all");
  useEffect(() => {
    // Retire saved filter URLs without touching other page state, e.g. the active tab.
    const url = new URL(window.location.href);
    url.searchParams.delete("tag");
    url.searchParams.delete("groupBy");
    url.searchParams.delete("network");
    url.searchParams.delete("health");
    url.searchParams.delete("strict");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, []);
  return { tagFilters, setTagFilters, groupBy, setGroupBy, health, setHealth };
}

/** Add the tag knobs to a metrics request. */
export function appendTagParams(params: URLSearchParams, tagFilters: Tag[], groupBy?: string, health: HealthMode = "all") {
  for (const t of tagFilters) params.append("tag", formatTag(t));
  if (groupBy) params.set("groupBy", groupBy);
  if (health === "strict") params.set("health", "strict");
  else params.delete("health");
}

/** A stable query-key part for the tag knobs. */
export function tagParamsKey(tagFilters: Tag[], groupBy?: string, health: HealthMode = "all"): string {
  return `${tagFilters.map(formatTag).sort().join(",")}|${groupBy ?? ""}|${health}`;
}

/** Custom (not known) keys seen in rows' tags, for the Group by list. */
export function customTagKeys(rows: Array<{ tags?: Tag[] | null }> | undefined, extra: Array<string | undefined> = []): string[] {
  const known = new Set<string>(KNOWN_TAG_KEYS);
  const keys = new Set<string>();
  for (const r of rows ?? []) for (const t of r.tags ?? []) if (!known.has(t.key)) keys.add(t.key);
  for (const k of extra) if (k && !known.has(k)) keys.add(k);
  return Array.from(keys).sort();
}

/** How a grouped row names its group: `isp:starlink`, `isp: untagged`, or a region's name. */
export function groupLabel(groupBy: string, tagValue: string | undefined): string {
  if (groupBy === REGION_GROUP_KEY) {
    return !tagValue || tagValue === "unattributed" ? "No region" : formatRegion(tagValue);
  }
  return !tagValue || tagValue === "untagged" ? `${groupBy}: untagged` : `${groupBy}:${tagValue}`;
}

/** Whether a grouped row is in its key's fallback group (`untagged` / `unattributed`). */
export function isEmptyGroup(groupBy: string, tagValue: string | undefined): boolean {
  return !tagValue || tagValue === (groupBy === REGION_GROUP_KEY ? "unattributed" : "untagged");
}

export { accessView, showAccessSplit, withAccessView, type AccessView } from "@/lib/access-view";

/**
 * All / Last mile / Datacenter — a shortcut for the `access` tag filter
 * (design "Last mile vs datacenter" → Analysis), so it shares the tag
 * filter's local state.
 */
export function AccessToggle({ tagFilters, onTagFiltersChange, showAll = true }: { tagFilters: Tag[]; onTagFiltersChange: (tags: Tag[]) => void; showAll?: boolean }) {
  const view = accessView(tagFilters);
  // With MAX_TAG_FILTERS other filters already set, picking an access class
  // would add one more than the server accepts.
  const full = tagFilters.length >= MAX_TAG_FILTERS && !tagFilters.some((t) => t.key === "access");
  // Native title tooltips: a Radix Tooltip trigger would overwrite each
  // item's data-state (on/off), which drives its pressed styling.
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={view === "other" || (!showAll && view === "all") ? "" : view}
      onValueChange={(v) => {
        if (v) onTagFiltersChange(withAccessView(tagFilters, v as AccessView));
        else if (!showAll) onTagFiltersChange(withAccessView(tagFilters, "all"));
      }}
      aria-label="Connection"
      data-testid="access-toggle"
    >
      {showAll && <ToggleGroupItem value="all" data-testid="access-toggle-all" title="Every result">All</ToggleGroupItem>}
      <ToggleGroupItem value="lastmile" data-testid="access-toggle-lastmile" disabled={full} title={LAST_MILE_HINT}>Last mile</ToggleGroupItem>
      <ToggleGroupItem value="datacenter" data-testid="access-toggle-datacenter" disabled={full} title={DATACENTER_HINT}>Datacenter</ToggleGroupItem>
    </ToggleGroup>
  );
}

const NONE = "__none__";

export function MetricsTagControls({
  tagFilters,
  onTagFiltersChange,
  groupBy,
  onGroupByChange,
  customKeys,
  showAllAccessOption = true,
}: {
  tagFilters: Tag[];
  onTagFiltersChange: (tags: Tag[]) => void;
  groupBy?: string;
  onGroupByChange: (key: string | undefined) => void;
  customKeys: string[];
  showAllAccessOption?: boolean;
}) {
  // `region` is offered once, on its own (it isn't a tag key) — never again as a "custom key".
  const keys = [...KNOWN_TAG_KEYS, ...customKeys.filter((k) => !(KNOWN_TAG_KEYS as readonly string[]).includes(k) && k !== REGION_GROUP_KEY)];
  return (
    <>
      <AccessToggle tagFilters={tagFilters} onTagFiltersChange={onTagFiltersChange} showAll={showAllAccessOption} />
      <TagInput
        value={tagFilters}
        onChange={onTagFiltersChange}
        maxTags={MAX_TAG_FILTERS}
        placeholder="Filter by tag, e.g. isp:starlink"
        className="w-full sm:w-[300px]"
        testId="metrics-tag-filter"
        aria-label="Filter by tag"
      />
      <Select value={groupBy ?? NONE} onValueChange={(v) => onGroupByChange(v === NONE ? undefined : v)}>
        <SelectTrigger className="w-[250px]" data-testid="select-group-by" aria-label="Group by">
          <SelectValue placeholder="Group by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No grouping</SelectItem>
          <SelectItem value={REGION_GROUP_KEY} data-testid="group-by-region">Group by region</SelectItem>
          {keys.map((k) => (
            <SelectItem key={k} value={k} data-testid={`group-by-${k}`}>
              Group by {k}{KNOWN_KEY_LABELS[k] ? ` (${KNOWN_KEY_LABELS[k]})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
