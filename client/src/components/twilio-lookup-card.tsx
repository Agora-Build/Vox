import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PhoneCall } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Twilio Lookup credentials for the `line` tag (designs/2026-10-22-network-tags-design.md
 * "Number lookup"): set, replace or remove. The token is write-only — the
 * server only ever returns whether it's configured and the SID, masked.
 */
type TwilioStatus = { configured: boolean; accountSidMasked: string | null };

const STATUS_KEY = ["/api/admin/number-lookup/twilio"];

export function TwilioLookupCard() {
  const { toast } = useToast();
  const { data: status, isLoading } = useQuery<TwilioStatus>({ queryKey: STATUS_KEY });
  const [editing, setEditing] = useState(false);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");

  const save = useMutation({
    mutationFn: async () => apiRequest("PUT", "/api/admin/number-lookup/twilio", { accountSid: accountSid.trim(), authToken: authToken.trim() }),
    onSuccess: () => {
      setEditing(false);
      setAccountSid("");
      setAuthToken("");
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({ title: "Twilio Lookup is on", description: "Phone flows are looked up on their next save or \"Look up again\"." });
    },
    onError: (error: Error) => toast({ title: "Couldn't save the credentials", description: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/admin/number-lookup/twilio"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({ title: "Twilio Lookup is off", description: "Existing lookups stay on their flows; new numbers aren't looked up." });
    },
    onError: (error: Error) => toast({ title: "Couldn't remove the credentials", description: error.message, variant: "destructive" }),
  });

  const showForm = editing || (status && !status.configured);

  return (
    <Card data-testid="card-twilio-lookup">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PhoneCall className="h-4 w-4" />Twilio Lookup</CardTitle>
        <CardDescription>
          Identifies the line provider (line: tag) of the number each phone flow dials, so results can be compared by
          phone line. Costs about $0.008 per number per month — each number is looked up once and cached for 30 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !status ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="twilio-lookup-status">
              {status.configured ? (
                <>
                  <Badge variant="secondary">On</Badge>
                  <span className="text-sm">Account SID <span className="font-mono">{status.accountSidMasked}</span></span>
                  {!editing && (
                    <div className="ml-auto flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="button-twilio-replace">Replace</Button>
                      <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()} data-testid="button-twilio-remove">Remove</Button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Badge variant="outline">Off</Badge>
                  <span className="text-sm text-muted-foreground">Line providers aren't looked up; flow owners add a line: tag by hand.</span>
                </>
              )}
            </div>
            {showForm && (
              <form
                className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="twilio-account-sid">Account SID</Label>
                  <Input
                    id="twilio-account-sid"
                    placeholder="AC…"
                    autoComplete="off"
                    value={accountSid}
                    onChange={(e) => setAccountSid(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="twilio-auth-token">Auth Token</Label>
                  <Input
                    id="twilio-auth-token"
                    type="password"
                    autoComplete="new-password"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  {editing && (
                    <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setAccountSid(""); setAuthToken(""); }}>
                      Cancel
                    </Button>
                  )}
                  <Button type="submit" size="sm" disabled={!accountSid.trim() || !authToken.trim() || save.isPending} data-testid="button-twilio-save">
                    Save
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
