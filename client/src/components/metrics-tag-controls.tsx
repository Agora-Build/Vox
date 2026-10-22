import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TagInput } from "@/components/tag-input";
import { formatRegion } from "@/lib/utils";
import { LAST_MILE_HINT, DATACENTER_HINT } from "@/lib/access-text";
import { KNOWN_TAG_KEYS, REGION_GROUP_KEY, formatTag, parseGroupBy, parseTagFilter, type Tag } from "@shared/tags";

/**
 * The network-tag knobs of a metrics view (designs/2026-10-22-network-tags-design.md
 * "Analysis"): `tag=key:value` filters (all must match) and `groupBy=key`.
 * Both live in the page URL, so a filtered, grouped view can be shared.
 */

const KNOWN_KEY_LABELS: Record<string, string> = {
  line: "line provider",
  isp: "network",
  link: "connection",
  access: "last mile / datacenter",
  sim: "SIM operator",
};

function readUrl(): { tagFilters: Tag[]; groupBy?: string } {
  const p = new URLSearchParams(window.location.search);
  const tf = parseTagFilter(p.getAll("tag"));
  const gb = parseGroupBy(p.get("groupBy") ?? undefined);
  return { tagFilters: "error" in tf ? [] : tf.filters, groupBy: "error" in gb ? undefined : gb.groupBy };
}

/** Tag filters + groupBy, initialised from and mirrored to the URL (replaceState: no history entry per keystroke). */
export function useMetricsTagUrlState() {
  const [initial] = useState(readUrl);
  const [tagFilters, setTagFilters] = useState<Tag[]>(initial.tagFilters);
  const [groupBy, setGroupBy] = useState<string | undefined>(initial.groupBy);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("tag");
    for (const t of tagFilters) url.searchParams.append("tag", formatTag(t));
    if (groupBy) url.searchParams.set("groupBy", groupBy);
    else url.searchParams.delete("groupBy");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [tagFilters, groupBy]);
  return { tagFilters, setTagFilters, groupBy, setGroupBy };
}

/** Add the tag knobs to a metrics request. */
export function appendTagParams(params: URLSearchParams, tagFilters: Tag[], groupBy?: string) {
  for (const t of tagFilters) params.append("tag", formatTag(t));
  if (groupBy) params.set("groupBy", groupBy);
}

/** A stable query-key part for the tag knobs. */
export function tagParamsKey(tagFilters: Tag[], groupBy?: string): string {
  return `${tagFilters.map(formatTag).sort().join(",")}|${groupBy ?? ""}`;
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


export type AccessView = "all" | "lastmile" | "datacenter";

/** Which access class the tag filters are narrowed to — the toggle's state. */
export function accessView(tagFilters: Tag[]): AccessView {
  const v = tagFilters.find((t) => t.key === "access")?.value;
  return v === "lastmile" || v === "datacenter" ? v : "all";
}

/** The tag filters with the access filter set to `view` (All removes it). */
export function withAccessView(tagFilters: Tag[], view: AccessView): Tag[] {
  const rest = tagFilters.filter((t) => t.key !== "access");
  return view === "all" ? rest : [...rest, { key: "access", value: view }];
}

/**
 * All / Last mile / Datacenter — a shortcut for the `access` tag filter
 * (design "Last mile vs datacenter" → Analysis), so it shares the tag
 * filter's URL state.
 */
export function AccessToggle({ tagFilters, onTagFiltersChange }: { tagFilters: Tag[]; onTagFiltersChange: (tags: Tag[]) => void }) {
  const view = accessView(tagFilters);
  // Native title tooltips: a Radix Tooltip trigger would overwrite each
  // item's data-state (on/off), which drives its pressed styling.
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={view}
      onValueChange={(v) => { if (v) onTagFiltersChange(withAccessView(tagFilters, v as AccessView)); }}
      aria-label="Connection"
      data-testid="access-toggle"
    >
      <ToggleGroupItem value="all" data-testid="access-toggle-all" title="Every result">All</ToggleGroupItem>
      <ToggleGroupItem value="lastmile" data-testid="access-toggle-lastmile" title={LAST_MILE_HINT}>Last mile</ToggleGroupItem>
      <ToggleGroupItem value="datacenter" data-testid="access-toggle-datacenter" title={DATACENTER_HINT}>Datacenter</ToggleGroupItem>
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
}: {
  tagFilters: Tag[];
  onTagFiltersChange: (tags: Tag[]) => void;
  groupBy?: string;
  onGroupByChange: (key: string | undefined) => void;
  customKeys: string[];
}) {
  // `region` is offered once, on its own (it isn't a tag key) — never again as a "custom key".
  const keys = [...KNOWN_TAG_KEYS, ...customKeys.filter((k) => !(KNOWN_TAG_KEYS as readonly string[]).includes(k) && k !== REGION_GROUP_KEY)];
  return (
    <>
      <AccessToggle tagFilters={tagFilters} onTagFiltersChange={onTagFiltersChange} />
      <TagInput
        value={tagFilters}
        onChange={onTagFiltersChange}
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
