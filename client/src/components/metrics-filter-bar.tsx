import { useState, type ReactNode } from "react";
import { MetricsTagControls } from "@/components/metrics-tag-controls";
import { HealthPolicyControls } from "@/components/health-policy-controls";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import type { HealthMode } from "@shared/metrics";
import type { Tag } from "@shared/tags";

interface MetricsFilterBarProps {
  idPrefix: string;
  tagFilters: Tag[];
  onTagFiltersChange: (tags: Tag[]) => void;
  groupBy?: string;
  onGroupByChange: (key: string | undefined) => void;
  health: HealthMode;
  onHealthChange: (mode: HealthMode) => void;
  customKeys: string[];
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Shared network filters, with page selectors before All and optional actions after it. */
export function MetricsFilterBar({
  idPrefix,
  tagFilters,
  onTagFiltersChange,
  groupBy,
  onGroupByChange,
  health,
  onHealthChange,
  customKeys,
  children,
  actions,
  className,
}: MetricsFilterBarProps) {
  // Keep any initial constraints visible; default All views start collapsed.
  const [networkFiltersVisible, setNetworkFiltersVisible] = useState(() => tagFilters.length > 0 || !!groupBy || health === "strict");
  const networkFiltersId = `${idPrefix}-network-filters`;

  return (
    <div className={cn("flex min-w-0 flex-col items-start gap-2 xl:items-end", className)}>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end" data-testid={`${idPrefix}-primary-filters`}>
        {networkFiltersVisible && <HealthPolicyControls health={health} onChange={onHealthChange} />}
        {children}
        <Toggle
          variant="outline"
          size="sm"
          pressed={!networkFiltersVisible}
          onPressedChange={(selected) => {
            setNetworkFiltersVisible(!selected);
            if (selected) {
              onTagFiltersChange([]);
              onGroupByChange(undefined);
              onHealthChange("all");
            }
          }}
          aria-expanded={networkFiltersVisible}
          aria-controls={networkFiltersId}
          aria-label="All networks"
          data-testid="access-toggle-all"
          title={networkFiltersVisible ? "Show all networks and reset network filters" : "All networks (Strict off). Click to show network filters."}
        >
          All
        </Toggle>
        {actions}
      </div>
      {networkFiltersVisible && (
        <div id={networkFiltersId} className="flex w-full flex-wrap items-center gap-2 sm:justify-end" data-testid={networkFiltersId}>
          <MetricsTagControls
            tagFilters={tagFilters}
            onTagFiltersChange={onTagFiltersChange}
            groupBy={groupBy}
            onGroupByChange={onGroupByChange}
            customKeys={customKeys}
            showAllAccessOption={false}
          />
        </div>
      )}
    </div>
  );
}
