import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { LineLookup } from "@shared/tags";

/**
 * A phone flow's number lookup (designs/2026-10-22-network-tags-design.md
 * "Number lookup"): which line provider the dialled number belongs to, and
 * "Look up again" for the flow's editors. A skipped lookup says why, in words.
 */

/** Saving a phone flow sends its dialled number to a third party: the form says so. */
export const LINE_LOOKUP_DISCLOSURE = "The dialled number is checked with Twilio Lookup to identify its line provider. A number stored as a secret is never sent.";

export type LineLookupSkip = "not-configured" | "secret" | "no-number" | "no-carrier" | "invalid-number" | "rate-limited" | "timeout" | "failed";

export const LINE_LOOKUP_SKIP_TEXT: Record<LineLookupSkip, string> = {
  "not-configured": "Automatic lookup is off — an admin can turn it on with Twilio Lookup credentials.",
  secret: "The number is stored as a secret, so it isn't looked up. Add a line: tag by hand.",
  "no-number": "No dialable number found in the Setup steps.",
  "invalid-number": "No dialable number found in the Setup steps.",
  "no-carrier": "Twilio has no carrier for this number (toll-free and some types). Add a line: tag by hand.",
  "rate-limited": "Automatic lookup is paused — too many lookups today. Try again tomorrow or tag the line provider by hand.",
  timeout: "The lookup is taking longer than usual — it will finish in the background.",
  failed: "The lookup didn't work this time. Try again.",
};

// ---- background lookup after a save ------------------------------------------
//
// Saving a phone flow never waits for Twilio: the server starts the lookup in
// the background and answers `lineLookupPending: true`. The console then says
// "Looking up the line provider…" for that flow and refetches the flow
// queries a few times; the lookup (cache-first) normally lands within seconds.

export const LINE_LOOKUP_PENDING_TEXT = "Looking up the line provider…";
/** When to refetch after a save started a lookup (ms) — the server's own timeout is 10 s. */
const PENDING_REFETCH_MS = [1500, 4000, 11000];

const pendingFlows = new Set<number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function refetchFlowQueries(flowId: number) {
  queryClient.invalidateQueries({ queryKey: ["/api/eval-flows"] });
  queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
  queryClient.invalidateQueries({ queryKey: [`/api/eval-flows/${flowId}`] });
}

/** Call with a save response: when it says a lookup is running, show it as pending and refetch until it lands. */
export function trackLineLookupPending(saved: { id?: number; lineLookupPending?: boolean } | null | undefined): void {
  const flowId = saved?.id;
  if (!saved?.lineLookupPending || typeof flowId !== "number") return;
  pendingFlows.add(flowId);
  notify();
  PENDING_REFETCH_MS.forEach((ms, i) => {
    setTimeout(() => {
      if (i === PENDING_REFETCH_MS.length - 1) { pendingFlows.delete(flowId); notify(); }
      refetchFlowQueries(flowId);
    }, ms);
  });
}

/** Whether a save of this flow started a lookup that may still be running. */
export function useLineLookupPending(flowId: number | undefined): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => flowId !== undefined && pendingFlows.has(flowId),
  );
}

/** Twilio's line types, in words. Unknown ones show as they came. */
function lineTypeText(lineType: string | null): string | null {
  if (!lineType) return null;
  const map: Record<string, string> = {
    nonFixedVoip: "VoIP",
    fixedVoip: "fixed VoIP",
    mobile: "mobile",
    landline: "landline",
    tollFree: "toll-free",
    premium: "premium",
    sharedCost: "shared cost",
    uan: "UAN",
    voicemail: "voicemail",
    pager: "pager",
    personal: "personal",
  };
  return map[lineType] ?? lineType;
}

export function describeLineLookup(l: LineLookup): string {
  const type = lineTypeText(l.lineType);
  const when = format(new Date(l.lookedUpAt), "d MMM yyyy");
  return `${l.value}${type ? ` (${type})` : ""} — looked up ${when}`;
}

export function LineLookupPanel({ flowId, lineLookup, canLookUp }: { flowId: number; lineLookup: LineLookup | null | undefined; canLookUp: boolean }) {
  const [answer, setAnswer] = useState<LineLookup | null>(lineLookup ?? null);
  const [skip, setSkip] = useState<LineLookupSkip | null>(null);
  useEffect(() => { setAnswer(lineLookup ?? null); setSkip(null); }, [flowId, lineLookup]);
  const pending = useLineLookupPending(flowId);

  const lookup = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/eval-flows/${flowId}/line-lookup`);
      return res.json() as Promise<{ lineLookup: LineLookup } | { skipped: LineLookupSkip }>;
    },
    onSuccess: (data) => {
      if ("lineLookup" in data) {
        setAnswer(data.lineLookup);
        setSkip(null);
        queryClient.invalidateQueries({ queryKey: ["/api/eval-flows"] });
        queryClient.invalidateQueries({ queryKey: ["/api/eval-flows?includePublic=true"] });
        queryClient.invalidateQueries({ queryKey: [`/api/eval-flows/${flowId}`] });
      } else {
        setSkip(data.skipped);
      }
    },
    onError: () => setSkip("failed"),
  });

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="line-lookup">
      <div className="flex items-center justify-between gap-3">
        <span data-testid="line-lookup-answer">
          {pending ? (
            <span className="text-muted-foreground" data-testid="line-lookup-pending">{LINE_LOOKUP_PENDING_TEXT}</span>
          ) : answer ? (
            <>Line provider: <span className="font-medium">{describeLineLookup(answer)}</span></>
          ) : (
            <span className="text-muted-foreground">Line provider: not looked up yet</span>
          )}
        </span>
        {canLookUp && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={lookup.isPending}
            onClick={() => lookup.mutate()}
            data-testid="button-line-lookup"
          >
            {lookup.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {answer ? "Look up again" : "Look up"}
          </Button>
        )}
      </div>
      {skip && <p className="text-xs text-muted-foreground" data-testid="line-lookup-skip">{LINE_LOOKUP_SKIP_TEXT[skip]}</p>}
      {canLookUp && !skip && (
        <p className="text-xs text-muted-foreground">Looks up the number in the saved Setup steps. A line: tag you set by hand is kept.</p>
      )}
    </div>
  );
}
