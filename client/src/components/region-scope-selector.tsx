import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Globe2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  cn,
  toggleRegionScopeSelection,
  formatRegionScopeSelection,
  resolveRegionScopeBaseIds,
  type RegionLocation,
} from "@/lib/utils";

interface RegionScopeSelectorProps {
  locations: RegionLocation[];
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
}

type ScopeState = boolean | "indeterminate";

export function RegionScopeSelector({ locations, value, onChange, className }: RegionScopeSelectorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hierarchy = useMemo(() => {
    const macros = new Map<string, {
      code: string;
      name: string;
      countries: Map<string, { code: string; name: string; locations: RegionLocation[] }>;
    }>();
    for (const location of locations) {
      let macro = macros.get(location.macroRegionCode);
      if (!macro) {
        macro = {
          code: location.macroRegionCode,
          name: location.macroRegionName,
          countries: new Map(),
        };
        macros.set(location.macroRegionCode, macro);
      }
      let country = macro.countries.get(location.countryCode);
      if (!country) {
        country = { code: location.countryCode, name: location.countryName, locations: [] };
        macro.countries.set(location.countryCode, country);
      }
      country.locations.push(location);
    }
    return Array.from(macros.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((macro) => ({
        ...macro,
        countries: Array.from(macro.countries.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((country) => ({
            ...country,
            locations: country.locations.sort((a, b) => a.displayName.localeCompare(b.displayName)),
          })),
      }));
  }, [locations]);

  const selectedBaseIds = useMemo(() => {
    return resolveRegionScopeBaseIds(locations, value);
  }, [locations, value]);

  const stateFor = (baseIds: string[]): ScopeState => {
    const selectedCount = baseIds.filter((baseId) => selectedBaseIds.has(baseId)).length;
    if (selectedCount === 0) return false;
    if (selectedCount === baseIds.length) return true;
    return "indeterminate";
  };

  const toggleScope = (baseIds: string[], scope: string) => {
    onChange(toggleRegionScopeSelection(locations, value, baseIds, scope));
  };

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const label = formatRegionScopeSelection(locations, value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-[190px] justify-between font-normal", className)}
          data-testid="button-region-scope"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="max-h-[min(420px,70vh)] overflow-y-auto p-2">
          <ScopeRow
            label="All"
            icon={<Globe2 className="h-4 w-4" />}
            state={value.includes("all")}
            onToggle={() => onChange(["all"])}
          />
          <div className="my-1 border-t" />
          {hierarchy.map((macro) => {
            const macroKey = `macro:${macro.code}`;
            const macroBaseIds = macro.countries.flatMap((country) => country.locations.map((location) => location.baseId));
            const macroOpen = expanded.has(macroKey);
            return (
              <div key={macroKey}>
                <ScopeRow
                  label={macro.name}
                  count={macroBaseIds.length}
                  state={stateFor(macroBaseIds)}
                  expanded={macroOpen}
                  onExpand={() => toggleExpanded(macroKey)}
                  onToggle={() => toggleScope(macroBaseIds, macroKey)}
                />
                {macroOpen && macro.countries.map((country) => {
                  const countryKey = `country:${country.code}`;
                  const countryBaseIds = country.locations.map((location) => location.baseId);
                  const countryOpen = expanded.has(countryKey);
                  return (
                    <div key={countryKey}>
                      <ScopeRow
                        label={country.name}
                        count={countryBaseIds.length}
                        state={stateFor(countryBaseIds)}
                        expanded={countryOpen}
                        inset={1}
                        onExpand={() => toggleExpanded(countryKey)}
                        onToggle={() => toggleScope(countryBaseIds, countryKey)}
                      />
                      {countryOpen && country.locations.map((location) => (
                        <ScopeRow
                          key={location.baseId}
                          label={location.displayName}
                          icon={<MapPin className="h-3.5 w-3.5" />}
                          state={selectedBaseIds.has(location.baseId)}
                          inset={2}
                          onToggle={() => toggleScope([location.baseId], `location:${location.baseId}`)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeRow({
  label,
  count,
  state,
  expanded,
  inset = 0,
  icon,
  onExpand,
  onToggle,
}: {
  label: string;
  count?: number;
  state: ScopeState;
  expanded?: boolean;
  inset?: number;
  icon?: React.ReactNode;
  onExpand?: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-9 items-center rounded-sm hover:bg-muted/60" style={{ paddingLeft: inset * 18 }}>
      {onExpand ? (
        <button type="button" className="grid h-8 w-7 place-items-center text-muted-foreground" onClick={onExpand}>
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : (
        <span className="w-7" />
      )}
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 pr-2">
        <Checkbox checked={state} onCheckedChange={onToggle} />
        {icon}
        <span className="truncate text-sm">{label}</span>
        {count !== undefined && <span className="ml-auto text-xs text-muted-foreground">{count}</span>}
      </label>
    </div>
  );
}
