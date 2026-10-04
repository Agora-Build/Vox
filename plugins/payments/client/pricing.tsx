import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, Button, Input, Label, ProtectedAction, apiRequest, queryClient } from "@vox/web-plugin-sdk";
import { money, type Billing } from "./panels";

interface Pricing { catalog: Billing["catalog"]; history: Array<{ id: number; premium_price_cents: number; topup_price_cents: number; topup_credits: number; admin_user_id: number | null; created_at: string }>; reviews: Array<{ event_id: string; user_ref: number; reason: string }> }
export default function PricingPanel() {
  const query = useQuery<Pricing>({ queryKey: ["/api/plugins/payments/pricing"] });
  const [open, setOpen] = useState(false);
  const [premium, setPremium] = useState("");
  const [topupPrice, setTopupPrice] = useState("");
  const [credits, setCredits] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const data = query.data;
  if (!data) return <p>{query.isError ? "Could not load admin pricing." : "Loading admin pricing..."}</p>;
  const payload = { baseVersion, premiumPriceCents: Math.round(Number(premium) * 100), topupPriceCents: Math.round(Number(topupPrice) * 100), topupCredits: Number(credits) };
  const valid = payload.premiumPriceCents >= 50 && payload.premiumPriceCents <= 1_000_000 && payload.topupPriceCents >= 50 && payload.topupPriceCents <= 1_000_000 && Number.isInteger(payload.topupCredits) && payload.topupCredits >= 1 && payload.topupCredits <= 1_000_000;
  return <Card><CardHeader><CardDescription>Admin only</CardDescription><CardTitle>Personal pricing</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm">Premium {money(data.catalog.premiumPriceCents)}/month &middot; {data.catalog.topupCredits} credits/{money(data.catalog.topupPriceCents)}</p>
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) { setPremium((data.catalog.premiumPriceCents / 100).toFixed(2)); setTopupPrice((data.catalog.topupPriceCents / 100).toFixed(2)); setCredits(String(data.catalog.topupCredits)); setBaseVersion(data.catalog.version); } }}>
      <DialogTrigger asChild><Button variant="outline">Edit pricing</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Update personal pricing</DialogTitle><DialogDescription>New purchases and subscriptions only. Existing subscribers and pending checkout quantities stay unchanged.</DialogDescription></DialogHeader>
        <Label htmlFor="premium-price">Premium monthly price (USD)</Label><Input id="premium-price" type="number" min="0.50" step="0.01" value={premium} onChange={(e) => setPremium(e.target.value)} />
        <Label htmlFor="topup-price">Price per pack (USD)</Label><Input id="topup-price" type="number" min="0.50" step="0.01" value={topupPrice} onChange={(e) => setTopupPrice(e.target.value)} />
        <Label htmlFor="topup-credits">Credits per pack</Label><Input id="topup-credits" type="number" min="1" value={credits} onChange={(e) => setCredits(e.target.value)} />
        <ProtectedAction action="payments.pricing" payload={payload} disabled={!valid} label="Publish pricing" onConfirm={async (verification) => {
          await apiRequest("PATCH", "/api/plugins/payments/pricing", { ...payload, verification }); setOpen(false);
          queryClient.invalidateQueries({ queryKey: ["/api/plugins/payments/pricing"] }); queryClient.invalidateQueries({ queryKey: ["/api/plugins/payments/usage"] });
        }} />
      </DialogContent>
    </Dialog>
    <details className="text-sm"><summary className="cursor-pointer">Pricing history</summary><div className="mt-3 space-y-2">{data.history.map((version) => <p key={version.id}>v{version.id} &middot; {money(version.premium_price_cents)}/month &middot; {version.topup_credits} credits/{money(version.topup_price_cents)} &middot; {new Date(version.created_at).toLocaleString()} &middot; {version.admin_user_id ? `Admin #${version.admin_user_id}` : "Initial defaults"}</p>)}</div></details>
    {!!data.reviews.length && <div className="rounded-md border p-3 text-sm"><p className="font-medium">Payment reviews requiring attention</p>{data.reviews.map((review) => <p key={review.event_id}>User #{review.user_ref}: {review.reason}</p>)}<p className="mt-2 text-muted-foreground">Review refunds and disputes manually; this release does not silently remove credits with active escrow.</p></div>}
  </CardContent></Card>;
}
