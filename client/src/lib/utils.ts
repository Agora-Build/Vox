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
export const REGIONS = [
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

export function formatRegion(region: string, locations = cachedRegionLocations): string {
  const normalized = region.toLowerCase();
  const legacy = {
    na: "North America",
    apac: "Asia Pacific",
    eu: "Europe",
    sa: "South America",
  }[normalized];
  if (legacy) return legacy;

  const location = [...locations]
    .sort((a, b) => b.baseId.length - a.baseId.length)
    .find((entry) => normalized.startsWith(entry.baseId + "-"));
  if (!location) return region;
  const sequence = normalized.slice(location.baseId.length + 1);
  return /^\d+$/.test(sequence)
    ? `${location.displayName} ${sequence.padStart(2, "0")}`
    : region;
}

export function resolveRegionScopeBaseIds(locations: RegionLocation[], scopes: string[]): Set<string> {
  if (scopes.includes("all")) return new Set(locations.map((location) => location.baseId));

  const selected = new Set<string>();
  for (const scope of scopes) {
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
  const wasAll = currentScopes.includes("all");
  const next = wasAll
    ? new Set<string>()
    : resolveRegionScopeBaseIds(locations, currentScopes);
  const allSelected = baseIds.every((baseId) => next.has(baseId));
  for (const baseId of baseIds) {
    if (allSelected) next.delete(baseId);
    else next.add(baseId);
  }
  const retainedScopes = currentScopes.filter((currentScope) => currentScope !== "all");
  const preferredScopes = allSelected ? retainedScopes : [scope, ...retainedScopes];
  return compressRegionScopeSelection(locations, next, preferredScopes);
}

export function formatRegionScopeSelection(locations: RegionLocation[], scopes: string[]): string {
  if (scopes.length === 0 || scopes.includes("all")) return "All Regions";

  const labels = scopes.map((scope) => {
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
