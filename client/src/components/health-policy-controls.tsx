import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Info } from "lucide-react";
import type { HealthMode } from "@shared/metrics";

export function HealthPolicyControls({ health, onChange }: {
  health: HealthMode; onChange: (mode: HealthMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 text-sm" data-testid="health-policy">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label="About strict mode" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Info className="h-4 w-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="max-w-[calc(100vw-2rem)] space-y-2 text-sm" align="end" data-testid="strict-health-info">
          <p className="font-medium">Strict agent health checks</p>
          <p>Only fully monitored runs without detected network changes are included. Changed runs and runs with incomplete or missing network monitoring are excluded.</p>
          <p>High CPU or memory does not directly exclude a run. Missing or rejected event deliveries can make monitoring incomplete.</p>
          <p className="text-muted-foreground">Turn Strict off to include these runs. Other filters still apply. Grouping always uses each run&apos;s initial network tags.</p>
        </PopoverContent>
      </Popover>
      <label className="flex items-center gap-2 cursor-pointer">
        <span>Strict</span>
        <Switch checked={health === "strict"} onCheckedChange={(checked) => onChange(checked ? "strict" : "all")} aria-label="Strict" data-testid="strict-health-mode" />
      </label>
    </div>
  );
}
