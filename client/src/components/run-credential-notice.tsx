import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CredentialTrialAllowance } from "@shared/credential-trials";

export interface RunCredentialPolicy {
  preferredTokenId?: number | null;
  runtimeSecretNames?: string[];
  requiresSessionConsent?: boolean;
  trial?: (CredentialTrialAllowance & { required: boolean }) | null;
}

export function RunCredentialNotice({ flowId, shared, ownAgent = false, policy, consent, onConsent }: {
  flowId: number; shared: boolean; policy: RunCredentialPolicy | undefined;
  ownAgent?: boolean;
  consent: boolean; onConsent: (v: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const clone = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/eval-flows/${flowId}/clone`, {})).json(),
    onSuccess: (flow) => {
      queryClient.invalidateQueries({ queryKey: ["/api/eval-flows"] });
      toast({ title: "Flow copied", description: "The copy uses your credentials, not the original owner's. Configure the referenced names under Secrets before running it." });
      navigate(`/console/eval-flows/${flow.id}`);
    },
    onError: (error: Error) => toast({ title: "Couldn't copy flow", description: error.message, variant: "destructive" }),
  });
  return (
    <>
      {shared && ownAgent && (
        <Alert data-testid="own-shared-credentials">
          <AlertTitle>Your own Shared agent</AlertTitle>
          <AlertDescription>Your personal flow can use your Runtime and Brokered secrets on your own agent. Other users' flows remain Brokered-only on Shared agents.</AlertDescription>
        </Alert>
      )}
      {shared && !ownAgent && !!policy?.runtimeSecretNames?.length && (
        <Alert variant="destructive" data-testid="shared-runtime-blocked">
          <AlertTitle>Shared agents require Brokered secrets</AlertTitle>
          <AlertDescription>Runtime secrets cannot be sent to Shared agents: {policy.runtimeSecretNames.join(", ")}. Choose a trusted agent or use Brokered secrets.</AlertDescription>
        </Alert>
      )}
      {shared && !ownAgent && policy?.requiresSessionConsent && !policy.runtimeSecretNames?.length && (
        <Alert data-testid="shared-session-consent">
          <AlertTitle>Share an authenticated session</AlertTitle>
          <AlertDescription>
            Raw login credentials stay on Core, but this Shared agent's operator can access the authenticated session. Use a limited test account.
            <label className="mt-2 flex items-start gap-2">
              <Checkbox checked={consent} onCheckedChange={(v) => onConsent(v === true)} className="mt-0.5" />
              I authorize sharing this account's authenticated session for this run.
            </label>
          </AlertDescription>
        </Alert>
      )}
      {policy?.trial?.required && (
        <Alert variant={policy.trial.available ? "default" : "destructive"} data-testid="credential-trial-notice">
          <AlertTitle>{policy.trial.available ? "Try this flow with its owner's credentials" : "Owner-credential trial unavailable"}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{policy.trial.reason ?? `Mainline only. You have ${policy.trial.remaining24Hours} of ${policy.trial.trialLimit24Hours} runs left in 24 hours and ${policy.trial.remaining30Days} of ${policy.trial.trialLimit30Days} in 30 days for this flow. The owner's shared run budget also applies.`}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => clone.mutate()} disabled={clone.isPending}>
              {clone.isPending ? "Copying..." : "Bring your own credentials"}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
