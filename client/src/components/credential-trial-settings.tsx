import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { CredentialTrialPolicy } from "@shared/credential-trials";

export function CredentialTrialSettings({ scope }: { scope: "personal" | "organization" }) {
  const path = `/api/credential-trials/${scope}`;
  const { toast } = useToast();
  const { data, isError } = useQuery<CredentialTrialPolicy & { used30Days: number }>({ queryKey: [path] });
  const [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState("0");
  useEffect(() => {
    if (data) { setEnabled(data.enabled); setBudget(String(data.maxRuns30Days)); }
  }, [data]);
  const mutation = useMutation({
    mutationFn: async () => (await apiRequest("PUT", path, { enabled, maxRuns30Days: Number(budget) })).json(),
    onSuccess: (saved) => {
      queryClient.setQueryData([path], saved);
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes("/run-targets") });
      toast({ title: "Public trial settings saved" });
    },
    onError: (error: Error) => toast({ title: "Couldn't save trial settings", description: error.message, variant: "destructive" }),
  });
  const valid = budget.trim() !== "" && Number.isInteger(Number(budget)) && Number(budget) >= (enabled ? 1 : 0) && Number(budget) <= 10000;
  return (
    <Card className="mt-4" data-testid={`trial-settings-${scope}`}>
      <CardHeader>
        <CardTitle className="text-base">Public flow trials</CardTitle>
        <CardDescription>
          Let signed-in users try your public flows on Mainline using {scope === "personal" ? "your" : "your organization's"} credentials.
          Off by default. This does not enable API runs or schedules for other users.
          Turning it off blocks further credential delivery to queued and running trials, but cannot retract credentials or sessions already delivered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? <p role="alert" className="text-sm text-destructive">Couldn't load trial settings. Refresh to try again.</p> : (
          <>
            <div className="flex items-center gap-3">
              <Switch id={`trials-${scope}`} checked={enabled} onCheckedChange={setEnabled} disabled={!data || mutation.isPending} />
              <Label htmlFor={`trials-${scope}`}>Allow borrowed-credential trials</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`trial-budget-${scope}`}>Shared run budget per rolling 30 days</Label>
              <Input id={`trial-budget-${scope}`} type="number" min={enabled ? 1 : 0} max={10000} step={1}
                className="max-w-48" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!data || mutation.isPending} aria-invalid={!valid} />
              {!valid && <p className="text-xs text-destructive">Set a whole-number budget from {enabled ? 1 : 0} to 10,000.</p>}
              <p className="text-xs text-muted-foreground">
                {data ? `${data.used30Days} admitted trials in the last 30 days. ` : "Loading settings. "}
                Across all flows in this credential scope. Each flow also has per-caller limits, defaulting to 5 runs per 24 hours and 80 per 30 days. Set those when creating or editing a public flow.
                Failed or canceled jobs count; invalid requests do not. This is a run cap, not a provider-cost guarantee.
              </p>
            </div>
            <Button onClick={() => mutation.mutate()} disabled={!data || !valid || mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Save trial settings"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
