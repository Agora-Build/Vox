import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  REGIONS,
  cacheRegionLocations,
  type RegionLocation,
} from "@/lib/utils";

export function useRegionLocations(admin = false) {
  const query = useQuery<RegionLocation[]>({
    queryKey: [admin ? "/api/admin/region-locations" : "/api/region-locations"],
  });

  useEffect(() => {
    if (query.data) cacheRegionLocations(query.data);
  }, [query.data]);

  return query;
}

export function useRegionOptions() {
  const query = useRegionLocations();
  const options = useMemo(() => {
    if (!query.data) return [...REGIONS];
    return query.data.filter((location) => location.isActive).flatMap((location) =>
      location.allocatedRegions.map((region) => {
        const sequence = region.slice(location.baseId.length + 1);
        return {
          value: region,
          label: `${location.displayName} ${sequence} · ${location.countryName}`,
        };
      }),
    );
  }, [query.data]);
  return { ...query, options };
}

export function useRegionLocationOptions() {
  const query = useRegionLocations();
  const options = useMemo(() => (query.data ?? []).filter((location) => location.isActive).map((location) => ({
    value: location.baseId,
    label: `${location.displayName}, ${location.countryName} · ${location.macroRegionName}`,
  })), [query.data]);
  return { ...query, options };
}
