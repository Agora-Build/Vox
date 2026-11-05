import { useQuery } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { appendRegionScopes } from "@/lib/utils";
import { appendTagParams, tagParamsKey } from "./metrics-tag-controls";
import type { Tag } from "@shared/tags";
import type { NetworkMode } from "@shared/network-events";

export function NetworkPolicyControls({ network, onChange, tier, timeRange, regionScopes, tagFilters, transport = "web", userId, enabled = true }: {
  network: NetworkMode; onChange: (mode: NetworkMode) => void;
  tier: string; timeRange: string; regionScopes: string[]; tagFilters: Tag[];
  transport?: "web" | "phone"; userId?: number | string; enabled?: boolean;
}) {
  const { data, isError } = useQuery<{ stable: number; changed: number; unverified: number }>({
    queryKey: ["/api/metrics/network-coverage", tier, userId, timeRange, [...regionScopes].sort().join(","), transport, tagParamsKey(tagFilters)],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ tier, transport });
      if (timeRange !== "all") params.set("hours", timeRange);
      appendRegionScopes(params, regionScopes);
      appendTagParams(params, tagFilters);
      const response = await fetch(`/api/metrics/network-coverage?${params}`, { signal });
      if (!response.ok) throw new Error("Failed to load network coverage");
      return response.json();
    }, enabled, staleTime: 30000, refetchInterval: 60000,
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid="network-policy">
      <div>
        <p className="font-medium">{network === "strict" ? "Strict network benchmark" : "All networks, including unstable runs"}</p>
        <p className="text-xs text-muted-foreground">{network === "strict"
          ? "Only fully monitored runs without a detected network change. Legacy and incomplete runs are excluded."
          : "Includes changed, legacy and incompletely monitored runs. Grouping still uses each run's initial network tags."}</p>
        {enabled && <p className="mt-1 text-xs text-muted-foreground" role="status">{data
          ? `${data.stable.toLocaleString()} verified stable / ${data.changed.toLocaleString()} changed / ${data.unverified.toLocaleString()} unverified`
          : isError ? "Network coverage counts unavailable" : "Loading network coverage..."}</p>}
      </div>
      <label className="flex shrink-0 items-center gap-2 cursor-pointer">
        <Switch checked={network === "all"} onCheckedChange={(checked) => onChange(checked ? "all" : "strict")} aria-label="Include unstable and unverified networks" data-testid="include-unstable-networks" />
        Include unstable / unverified
      </label>
    </div>
  );
}
