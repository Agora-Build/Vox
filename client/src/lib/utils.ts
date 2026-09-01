import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns"
import { dump as dumpYaml } from "js-yaml"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Friendly display label for a broker type. Shared by the secrets
 * broker-class dropdown and the Registered Brokers list so both render
 * the same wording for a given type.
 */
export function brokerTypeLabel(t: string): string {
  if (t === "auth-session") return "Brokered — login/session";
  return t;
}

/**
 * Smart timestamp: relative for recent, absolute for older.
 * < 60 min: "X minutes ago"
 * 1–8 hours: "X hours ago"
 * >= 8 hours: "2026-03-04 09:00:42"
 */
export const SITES = [
  { value: "na-us-seattle-01", label: "Seattle 01" },
  { value: "apac-sg-01", label: "Singapore 01" },
  { value: "eu-de-frankfurt-01", label: "Frankfurt 01" },
  { value: "sa-br-saopaulo-01", label: "Sao Paulo 01" },
] as const;

export interface RegionLocation {
  id: number;
  baseId: string;
  displayName: string;
  city: string;
  countryCode: string;
  countryName: string;
  macroRegionCode: string;
  macroRegionName: string;
  nextSequence: number;
  isActive: boolean;
  allocatedRegions: string[];
  createdAt: string;
  updatedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  source?: string;
  isMainline?: boolean;
}

const DEFAULT_REGION_LOCATIONS: Pick<RegionLocation, "baseId" | "displayName">[] = [
  { baseId: "na-us-seattle", displayName: "Seattle" },
  { baseId: "apac-sg", displayName: "Singapore" },
  { baseId: "apac-in-mumbai", displayName: "Mumbai" },
  { baseId: "eu-de-frankfurt", displayName: "Frankfurt" },
  { baseId: "sa-br-saopaulo", displayName: "Sao Paulo" },
];

let cachedRegionLocations: Pick<RegionLocation, "baseId" | "displayName">[] = DEFAULT_REGION_LOCATIONS;

export function cacheRegionLocations(locations: RegionLocation[]): void {
  cachedRegionLocations = locations;
}

export type SiteId = string;   // "na-us-seattle-02"
export type Region = string;   // "na-us-seattle" (a region_locations.baseId)

// Longest-prefix match of a site-id against the known region_locations, extracting
// its trailing numeric sequence. Returns null when the id does not resolve to a
// known region + numeric sequence. Shared by regionOf and formatSite.
function matchSite(
  siteId: SiteId,
  locations: Pick<RegionLocation, "baseId" | "displayName">[],
): { baseId: string; displayName: string; sequence: string } | null {
  const normalized = siteId.toLowerCase();
  const location = [...locations]
    .sort((a, b) => b.baseId.length - a.baseId.length)
    .find((entry) => normalized.startsWith(entry.baseId + "-"));
  if (!location) return null;
  const sequence = normalized.slice(location.baseId.length + 1);
  if (!/^\d+$/.test(sequence)) return null;
  return { baseId: location.baseId, displayName: location.displayName, sequence };
}

// "na-us-seattle-02" -> "na-us-seattle": strip the trailing -NN sequence.
// Returns the input unchanged when it has no -NN sequence.
export function regionOf(siteId: SiteId, locations = cachedRegionLocations): Region {
  const match = matchSite(siteId, locations);
  return match ? match.baseId : siteId;
}

// "na-us-seattle" -> "Seattle": region display name (area only, no sequence).
export function formatRegion(region: Region, locations = cachedRegionLocations): string {
  const match = locations.find((loc) => loc.baseId === region.toLowerCase());
  return match ? match.displayName : region;
}

// "na-us-seattle-02" -> "Seattle 02": site label (region display name + sequence).
export function formatSite(siteId: SiteId, locations = cachedRegionLocations): string {
  const match = matchSite(siteId, locations);
  return match ? `${match.displayName} ${match.sequence.padStart(2, "0")}` : siteId;
}

export function resolveRegionScopeBaseIds(locations: RegionLocation[], scopes: string[]): Set<string> {
  if (scopes.includes("all")) return new Set(locations.map((location) => location.baseId));

  const selected = new Set<string>();
  for (const scope of scopes) {
    if (scope === "unverified") continue; // not a geographic scope; resolved separately
    const [level, value] = scope.split(":", 2);
    for (const location of locations) {
      if (
        (level === "macro" && location.macroRegionCode === value) ||
        (level === "country" && location.countryCode === value) ||
        (level === "location" && location.baseId === value)
      ) {
        selected.add(location.baseId);
      }
    }
  }
  return selected;
}

export function compressRegionScopeSelection(
  locations: RegionLocation[],
  selectedBaseIds: Set<string>,
  preferredScopes: string[] = [],
): string[] {
  const recognized = new Set(
    locations
      .map((location) => location.baseId)
      .filter((baseId) => selectedBaseIds.has(baseId)),
  );
  if (recognized.size === 0 || recognized.size === locations.length) return ["all"];

  const scopes: string[] = [];
  const remaining = new Set(recognized);
  for (const preferredScope of Array.from(new Set(preferredScopes))) {
    const preferredBaseIds = resolveRegionScopeBaseIds(locations, [preferredScope]);
    if (
      preferredBaseIds.size > 0 &&
      Array.from(preferredBaseIds).every((baseId) => remaining.has(baseId))
    ) {
      scopes.push(preferredScope);
      preferredBaseIds.forEach((baseId) => remaining.delete(baseId));
    }
  }

  for (const location of locations.slice().sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    if (remaining.has(location.baseId)) scopes.push(`location:${location.baseId}`);
  }
  return scopes;
}

export function toggleRegionScopeSelection(
  locations: RegionLocation[],
  currentScopes: string[],
  baseIds: string[],
  scope: string,
): string[] {
  const unverifiedScopes = currentScopes.filter((s) => s === "unverified");
  const geoScopes = currentScopes.filter((s) => s !== "unverified");

  const wasAll = geoScopes.includes("all");
  const next = wasAll
    ? new Set<string>()
    : resolveRegionScopeBaseIds(locations, geoScopes);
  const allSelected = baseIds.every((baseId) => next.has(baseId));
  for (const baseId of baseIds) {
    if (allSelected) next.delete(baseId);
    else next.add(baseId);
  }
  const retainedScopes = geoScopes.filter((currentScope) => currentScope !== "all");
  const preferredScopes = allSelected ? retainedScopes : [scope, ...retainedScopes];
  const result = compressRegionScopeSelection(locations, next, preferredScopes);
  return [...result, ...unverifiedScopes];
}

export function formatRegionScopeSelection(locations: RegionLocation[], scopes: string[]): string {
  if (scopes.length === 0 || scopes.includes("all")) return "All Regions";

  const labels = scopes.map((scope) => {
    if (scope === "unverified") return "Unverified";
    const [level, value] = scope.split(":", 2);
    if (level === "macro") {
      return locations.find((location) => location.macroRegionCode === value)?.macroRegionName;
    }
    if (level === "country") {
      return locations.find((location) => location.countryCode === value)?.countryName;
    }
    if (level === "location") {
      return locations.find((location) => location.baseId === value)?.displayName;
    }
    return undefined;
  }).filter((label): label is string => Boolean(label));

  if (labels.length === 0) return "All Regions";
  if (labels.length <= 2) return labels.join(" + ");
  return `${labels.length} region groups`;
}

export function toggleUnverifiedScope(currentScopes: string[]): string[] {
  const withoutAll = currentScopes.filter((s) => s !== "all");
  return withoutAll.includes("unverified")
    ? (withoutAll.filter((s) => s !== "unverified").length ? withoutAll.filter((s) => s !== "unverified") : ["all"])
    : [...withoutAll, "unverified"];
}

export function appendRegionScopes(params: URLSearchParams, scopes: string[]): void {
  const effectiveScopes = scopes.filter((scope) => scope !== "all");
  if (effectiveScopes.length > 0) params.set("regionScope", effectiveScopes.join(","));
}

// Render a JS value as readable YAML for read-only config display (workflow/eval-set
// snapshots, app config). Uses js-yaml's serializer; lineWidth -1 keeps long
// step/scenario lines intact. Falls back to JSON for the rare value it can't dump.
export function toYaml(obj: unknown): string {
  try {
    return dumpYaml(obj ?? null, { indent: 2, lineWidth: -1 }).trimEnd();
  } catch {
    return JSON.stringify(obj, null, 2);
  }
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
