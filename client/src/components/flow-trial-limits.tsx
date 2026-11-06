import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trialLimitSchema } from "@shared/credential-trials";

export const validFlowTrialLimit = (value: string) => value.trim() !== "" && trialLimitSchema.safeParse(Number(value)).success;

export function FlowTrialLimits({ prefix, daily, monthly, onDaily, onMonthly, disabled = false }: {
  prefix: string; daily: string; monthly: string;
  onDaily: (value: string) => void; onMonthly: (value: string) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled} data-testid={`${prefix}-trial-limits`}>
      <legend className="px-1 text-sm font-medium">Public trial limits per user</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-trial-daily`}>Runs per 24 hours</Label>
          <Input id={`${prefix}-trial-daily`} type="number" min={0} max={10000} step={1} value={daily}
            onChange={(e) => onDaily(e.target.value)} aria-invalid={!validFlowTrialLimit(daily)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-trial-monthly`}>Runs per 30 days</Label>
          <Input id={`${prefix}-trial-monthly`} type="number" min={0} max={10000} step={1} value={monthly}
            onChange={(e) => onMonthly(e.target.value)} aria-invalid={!validFlowTrialLimit(monthly)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Rolling limits for this flow's borrowed-credential trials on Mainline. Defaults: 5 per 24 hours and 80 per 30 days. Zero disables trials for this flow. Your credential-scope opt-in and shared budget under Secrets also apply; your own runs are not trials.</p>
      {(!validFlowTrialLimit(daily) || !validFlowTrialLimit(monthly)) && <p role="alert" className="text-xs text-destructive">Use whole numbers from 0 to 10,000.</p>}
      {disabled && <p className="text-xs text-muted-foreground">Only organization secret managers can change these limits.</p>}
    </fieldset>
  );
}
