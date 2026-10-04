import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, Button, Input, Label, ProtectedAction, apiRequest, queryClient } from "@vox/web-plugin-sdk";
export default function GrantDialog({ userIds, names }: { userIds: number[]; names: string[] }) {
  const [open, setOpen] = useState(false);
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [credits, setCredits] = useState("100");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const ids = Array.from(new Set(userIds)).sort((a, b) => a - b);
  const payload = { batchId, userIds: ids, credits: Number(credits), reason: reason.trim() };
  const valid = ids.length > 0 && ids.length <= 500 && Number.isSafeInteger(payload.credits) && payload.credits > 0 && payload.credits <= 1_000_000_000 && payload.reason.length >= 3;
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value && done) { setBatchId(crypto.randomUUID()); setDone(false); setReason(""); } }}>
    <DialogTrigger asChild><Button variant="outline" size="sm" disabled={!ids.length}>Grant credits{ids.length > 1 ? ` (${ids.length})` : ""}</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Grant personal credits</DialogTitle><DialogDescription>Credits are added to each user's personal balance, not an organization wallet.</DialogDescription></DialogHeader>
      {done ? <p role="status">Grant approved. Completed recipients cannot receive this batch twice; any interrupted work resumes automatically.</p> : <>
        <div className="max-h-28 overflow-y-auto rounded-md border p-3 text-sm">{names.join(", ")}<p className="mt-2 text-muted-foreground">{ids.length} recipients &middot; {Number.isFinite(payload.credits) ? (payload.credits * ids.length).toLocaleString() : 0} total credits</p></div>
        <Label htmlFor="grant-credits">Credits per user</Label><Input id="grant-credits" type="number" min="1" value={credits} onChange={(e) => setCredits(e.target.value)} />
        <Label htmlFor="grant-reason">Reason</Label><Input id="grant-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ProtectedAction action="credits.grant" payload={payload} disabled={!valid} label="Approve grant" onConfirm={async (verification) => {
          await apiRequest("POST", "/api/plugins/credits/grants", { ...payload, verification });
          setDone(true);
          queryClient.invalidateQueries({ queryKey: ["/api/plugins/credits/usage"] });
          queryClient.invalidateQueries({ queryKey: ["/api/plugins/credits/balance"] });
          queryClient.invalidateQueries({ queryKey: ["personal-statement"] });
        }} />
      </>}
    </DialogContent>
  </Dialog>;
}
